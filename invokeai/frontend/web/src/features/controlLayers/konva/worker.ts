import type { LogLevel } from 'app/logging/logger';
import type { JsonObject } from 'roarr/dist/types';

export type Extents = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/**
 * Get the bounding box of an image.
 * @param buffer The ArrayBufferLike of the image to get the bounding box of.
 * @param width The width of the image.
 * @param height The height of the image.
 * @returns The minimum and maximum x and y values of the image's bounding box, or null if the image has no pixels.
 */
const getImageDataBboxArrayBufferLike = (buffer: ArrayBufferLike, width: number, height: number): Extents | null => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let alpha = 0;
  let isEmpty = true;
  const arr = new Uint8ClampedArray(buffer);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      alpha = arr[(y * width + x) * 4 + 3] ?? 0;
      if (alpha > 0) {
        isEmpty = false;
        if (x < minX) {
          minX = x;
        }
        if (x > maxX) {
          maxX = x;
        }
        if (y < minY) {
          minY = y;
        }
        if (y > maxY) {
          maxY = y;
        }
      }
    }
  }

  return isEmpty ? null : { minX, minY, maxX: maxX + 1, maxY: maxY + 1 };
};

// --- Felzenszwalb-Huttenlocher Euclidean Distance Transform ---
// Based on Mourner's implementation (Mapbox TinySDF), which implements the
// algorithm from "Distance Transforms of Sampled Functions" (Felzenszwalb & Huttenlocher, 2012).
// Computes exact squared Euclidean distances in O(N) time via separable 1D passes.

const INF = 1e20;

/**
 * 1D distance transform using parabola lower-envelope intersection.
 * Operates in-place on `grid` via offset+stride addressing.
 * Pre-allocated buffers f, v, z are reused across calls.
 */
function edt1d(
  grid: Float64Array,
  offset: number,
  stride: number,
  length: number,
  f: Float64Array,
  v: Uint32Array,
  z: Float64Array
): void {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset]!;

  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride]!;
    const q2 = q * q;
    do {
      const r = v[k]!;
      s = (f[q]! - f[r]! + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k]! && --k > -1);

    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1]! < q) {
      k++;
    }
    const r = v[k]!;
    const qr = q - r;
    grid[offset + q * stride] = f[r]! + qr * qr;
  }
}

/**
 * 2D Euclidean Distance Transform. Runs 1D EDT on all columns, then all rows.
 * Mutates `data` in-place: after this call, data[i] contains the squared Euclidean
 * distance from pixel i to the nearest zero-valued pixel.
 */
function edt(
  data: Float64Array,
  width: number,
  height: number,
  f: Float64Array,
  v: Uint32Array,
  z: Float64Array
): void {
  // Column pass
  for (let x = 0; x < width; x++) {
    edt1d(data, x, width, height, f, v, z);
  }
  // Row pass
  for (let y = 0; y < height; y++) {
    edt1d(data, y * width, 1, width, f, v, z);
  }
}

/**
 * Computes a Signed Distance Transform from an RGBA image buffer.
 * Returns a Float32Array where positive values = distance inside the shape (from boundary inward),
 * negative values = distance outside the shape, and 0 = at the boundary.
 */
function computeSdt(buffer: ArrayBufferLike, width: number, height: number): Float32Array {
  const pixels = new Uint8ClampedArray(buffer);
  const size = width * height;
  const maxDim = Math.max(width, height);

  // Pre-allocate reusable buffers for the 1D EDT
  const f = new Float64Array(maxDim);
  const v = new Uint32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  // gridOuter: distance from OUTSIDE pixels to nearest INSIDE pixel
  // gridInner: distance from INSIDE pixels to nearest OUTSIDE pixel
  const gridOuter = new Float64Array(size);
  const gridInner = new Float64Array(size);

  for (let i = 0; i < size; i++) {
    const alpha = pixels[i * 4 + 3]!;
    if (alpha > 128) {
      gridOuter[i] = 0;
      gridInner[i] = INF;
    } else {
      gridOuter[i] = INF;
      gridInner[i] = 0;
    }
  }

  // Run 2D EDT on both grids
  edt(gridOuter, width, height, f, v, z);
  edt(gridInner, width, height, f, v, z);

  // Compute signed distance: positive = inside, negative = outside
  const sdt = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    sdt[i] = Math.sqrt(gridInner[i]!) - Math.sqrt(gridOuter[i]!);
  }

  return sdt;
}

// --- Task Types ---

export type GetBboxTask = {
  type: 'get_bbox';
  data: { id: string; buffer: ArrayBufferLike; width: number; height: number };
};

export type ComputeSdtTask = {
  type: 'compute_sdt';
  data: { id: string; buffer: ArrayBufferLike; width: number; height: number };
};

type AnyTask = GetBboxTask | ComputeSdtTask;
type TaskWithTimestamps<T extends Record<string, unknown>> = T & { started: number | null; finished: number | null };

export type ExtentsResult = {
  type: 'extents';
  data: { id: string; extents: Extents | null };
};

export type SdtResult = {
  type: 'sdt';
  data: { id: string; sdt: ArrayBufferLike; width: number; height: number };
};

export type WorkerLogMessage = {
  type: 'log';
  data: { level: LogLevel; message: string; ctx?: JsonObject };
};

// A single worker is used to process tasks in a queue
const queue: TaskWithTimestamps<AnyTask>[] = [];
let currentTask: TaskWithTimestamps<AnyTask> | null = null;

function postLogMessage(level: LogLevel, message: string, ctx?: JsonObject) {
  const data: WorkerLogMessage = {
    type: 'log',
    data: { level, message, ctx },
  };
  self.postMessage(data);
}

function processNextTask() {
  // Grab the next task
  const task = queue.shift();
  if (!task) {
    // Queue empty - we can clear the current task to allow the worker to resume the queue when another task is posted
    currentTask = null;
    return;
  }

  postLogMessage('debug', 'Processing task', { type: task.type, id: task.data.id });
  task.started = performance.now();

  // Set the current task so we don't process another one
  currentTask = task;

  // Process the task
  if (task.type === 'get_bbox') {
    const { buffer, width, height, id } = task.data;
    const extents = getImageDataBboxArrayBufferLike(buffer, width, height);
    const result: ExtentsResult = {
      type: 'extents',
      data: { id, extents },
    };
    task.finished = performance.now();
    postLogMessage('debug', 'Task complete', {
      type: task.type,
      id: task.data.id,
      started: task.started,
      finished: task.finished,
      durationMs: task.finished - task.started,
    });
    self.postMessage(result);
  } else if (task.type === 'compute_sdt') {
    const { buffer, width, height, id } = task.data;
    const sdt = computeSdt(buffer, width, height);
    const result: SdtResult = {
      type: 'sdt',
      data: { id, sdt: sdt.buffer, width, height },
    };
    task.finished = performance.now();
    postLogMessage('debug', 'Task complete', {
      type: task.type,
      id: task.data.id,
      started: task.started,
      finished: task.finished,
      durationMs: task.finished - task.started,
    });
    self.postMessage(result);
  } else {
    postLogMessage('error', 'Unknown task type', { type: (task as AnyTask).type });
  }

  // Repeat
  processNextTask();
}

self.onmessage = (event: MessageEvent<Omit<AnyTask, 'started' | 'finished'>>) => {
  const task = event.data;

  postLogMessage('debug', 'Received task', { type: task.type, id: task.data.id });
  // Add the task to the queue
  queue.push({ ...event.data, started: null, finished: null });

  // If we are not currently processing a task, process the next one
  if (!currentTask) {
    processNextTask();
  }
};
