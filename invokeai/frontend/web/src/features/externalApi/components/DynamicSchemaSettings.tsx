import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import {
  Box,
  Combobox,
  CompositeNumberInput,
  Flex,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Switch,
  Text,
} from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import { TRANSPARENCY_CHECKERBOARD_PATTERN_DARK_DATAURL } from 'features/controlLayers/konva/patterns/transparency-checkerboard-pattern';
import type { AddDynamicSchemaImageDndTargetData } from 'features/dnd/dnd';
import { addDynamicSchemaImageDndTarget } from 'features/dnd/dnd';
import { DndDropTarget } from 'features/dnd/DndDropTarget';
import { DndImage } from 'features/dnd/DndImage';
import { DndImageIcon } from 'features/dnd/DndImageIcon';
import {
  externalApiDynamicImageFieldCleared,
  externalApiDynamicImageRemoved,
  externalApiDynamicParamChanged,
  selectExternalApiDynamicImageParams,
  selectExternalApiDynamicParams,
} from 'features/externalApi/store/externalApiSlice';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { PiTrashSimpleBold } from 'react-icons/pi';
import { useGetImageDTOQuery } from 'services/api/endpoints/images';

/**
 * Fields that are wired to the main UI and should not appear as dynamic controls.
 * - prompt: wired to the main prompt text box
 * - seed: handled by the seed system in the graph builder
 * - num_images/max_images/etc.: handled by our queue/batching system
 *
 * NOTE: Image fields (image, image_url, input_images, etc.) are NOT skipped here —
 * they are detected by isImageField() and rendered as image drop zones instead.
 */
const SKIP_FIELDS = new Set([
  'prompt',
  'seed',
  'negative_prompt',
  'num_images',
  'max_images',
  'number_of_images',
  'num_outputs',
  'n',
  'batch_size',
]);

/** Field names that represent image inputs. */
const IMAGE_FIELD_NAMES = new Set([
  'image',
  'images',
  'image_url',
  'image_urls',
  'input_image',
  'input_images',
  'reference_image',
  'reference_images',
  'mask',
  'mask_url',
  'mask_image',
  'source_image',
  'source_images',
  'control_image',
  'style_image',
]);

type SchemaProperty = {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  'x-order'?: number;
  allOf?: Array<{ $ref?: string; enum?: unknown[] }>;
  anyOf?: Array<{ type?: string }>;
  oneOf?: Array<{ type?: string }>;
  $ref?: string;
  items?: { type?: string; format?: string };
  format?: string;
  maxItems?: number;
};

type JsonSchema = {
  properties?: Record<string, SchemaProperty>;
  'x-fal-order-properties'?: string[];
  definitions?: Record<string, SchemaProperty>;
  $defs?: Record<string, SchemaProperty>;
};

/** Detect whether a schema field represents an image input. */
function isImageField(key: string, prop: SchemaProperty): boolean {
  if (IMAGE_FIELD_NAMES.has(key)) {
    return true;
  }
  // Array of URIs
  if (prop.type === 'array' && prop.items?.format === 'uri') {
    return true;
  }
  // Single URI with "image" in the name
  if (prop.type === 'string' && prop.format === 'uri' && key.toLowerCase().includes('image')) {
    return true;
  }
  return false;
}

/** Extract max image count from the description text, e.g. "Maximum 8 images". */
function parseMaxImages(description?: string): number {
  if (!description) {
    return 8;
  }
  const match = description.match(/(?:maximum|up to|max)\s+(\d+)\s+images?/i);
  return match ? parseInt(match[1]!, 10) : 8;
}

/** Resolve $ref pointers (simple single-level only). */
function resolveRef(schema: JsonSchema, ref: string): SchemaProperty | null {
  // e.g. "#/definitions/ImageSize" or "#/$defs/ImageSize"
  const parts = ref.replace('#/', '').split('/');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = schema;
  for (const part of parts) {
    current = current?.[part];
    if (!current) {
      return null;
    }
  }
  return current as SchemaProperty;
}

/** Resolve the effective type and constraints of a property (handling allOf, anyOf wrapping).
 *
 * Schemas are pre-resolved on the backend (all $ref inlined), so most properties
 * should already have their type/enum directly. This handles residual wrapping patterns.
 */
function resolveProperty(schema: JsonSchema, prop: SchemaProperty): SchemaProperty {
  const keepFields = { title: prop.title, description: prop.description, default: prop.default, 'x-order': prop['x-order'] };

  // Handle allOf — merge all items into one resolved property
  if (prop.allOf?.length) {
    let merged: SchemaProperty = {};
    for (const item of prop.allOf) {
      if (item.$ref) {
        const resolved = resolveRef(schema, item.$ref);
        if (resolved) {
          merged = { ...merged, ...resolved };
        }
      } else {
        merged = { ...merged, ...item };
      }
    }
    // Overlay the original property's metadata
    return { ...merged, ...filterDefined(keepFields) };
  }

  // Direct $ref (fallback — should be pre-resolved now)
  if (prop.$ref) {
    const resolved = resolveRef(schema, prop.$ref);
    if (resolved) {
      return { ...resolved, ...filterDefined(keepFields) };
    }
  }

  // Handle anyOf — prefer the variant with enum or concrete type (skip null)
  if (prop.anyOf?.length) {
    // First prefer one with enum values
    const withEnum = prop.anyOf.find((t) => (t as SchemaProperty).enum?.length);
    if (withEnum) {
      return { ...prop, ...withEnum };
    }
    // Then pick first non-null type
    const nonNull = prop.anyOf.find((t) => t.type !== 'null');
    if (nonNull) {
      return { ...prop, ...nonNull };
    }
  }

  return prop;
}

/** Filter out undefined values from an object. */
function filterDefined(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      result[k] = v;
    }
  }
  return result;
}

/** Format a key name into a readable label: "guidance_scale" → "Guidance Scale" */
function formatLabel(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Get ordered property keys from the schema. */
function getOrderedKeys(schema: JsonSchema): string[] {
  if (!schema.properties) {
    return [];
  }
  const keys = Object.keys(schema.properties).filter((k) => !SKIP_FIELDS.has(k));

  // FAL ordering: x-fal-order-properties
  if (schema['x-fal-order-properties']?.length) {
    const orderList = schema['x-fal-order-properties'];
    const ordered = orderList.filter((k) => keys.includes(k));
    const remaining = keys.filter((k) => !orderList.includes(k));
    return [...ordered, ...remaining];
  }

  // Replicate ordering: x-order on individual properties
  const withOrder = keys.filter((k) => schema.properties![k]!['x-order'] !== undefined);
  if (withOrder.length > 0) {
    return keys.sort((a, b) => {
      const orderA = schema.properties![a]!['x-order'] ?? 999;
      const orderB = schema.properties![b]!['x-order'] ?? 999;
      return orderA - orderB;
    });
  }

  return keys;
}

type Props = {
  schema: Record<string, unknown>;
};

/**
 * Renders dynamic settings controls from a JSON Schema.
 * Maps schema property types to InvokeAI UI components:
 * - image fields → DynamicImageField (drop zone)
 * - string + enum → Combobox
 * - integer/number (with min/max) → CompositeNumberInput
 * - boolean → Switch
 * - string (no enum) → Input
 * - Complex/nested → skipped
 */
export const DynamicSchemaSettings = memo(({ schema }: Props) => {
  const jsonSchema = schema as JsonSchema;
  const orderedKeys = useMemo(() => getOrderedKeys(jsonSchema), [jsonSchema]);

  if (!orderedKeys.length) {
    return null;
  }

  return (
    <>
      {orderedKeys.map((key) => {
        const rawProp = jsonSchema.properties![key]!;
        const prop = resolveProperty(jsonSchema, rawProp);
        return <DynamicField key={key} fieldKey={key} prop={prop} schema={jsonSchema} />;
      })}
    </>
  );
});

DynamicSchemaSettings.displayName = 'DynamicSchemaSettings';

// --- Individual field components ---

type FieldProps = {
  fieldKey: string;
  prop: SchemaProperty;
};

type DynamicFieldProps = FieldProps & {
  schema: JsonSchema;
};

const DynamicField = memo(({ fieldKey, prop, schema }: DynamicFieldProps) => {
  // Check for image fields first — render as drop zone
  if (isImageField(fieldKey, prop)) {
    const resolved = resolveProperty(schema, prop);
    const isSingle = resolved.type !== 'array';
    const maxImages = isSingle ? 1 : (resolved.maxItems ?? parseMaxImages(resolved.description));
    return <DynamicImageField fieldKey={fieldKey} prop={resolved} maxImages={maxImages} />;
  }
  // Determine field type
  if (prop.enum?.length) {
    return <EnumField fieldKey={fieldKey} prop={prop} />;
  }
  if (prop.type === 'boolean') {
    return <BooleanField fieldKey={fieldKey} prop={prop} />;
  }
  if (prop.type === 'integer' || prop.type === 'number') {
    return <NumberField fieldKey={fieldKey} prop={prop} />;
  }
  if (prop.type === 'string') {
    return <StringField fieldKey={fieldKey} prop={prop} />;
  }
  // Skip complex types (objects, arrays without image detection)
  return null;
});

DynamicField.displayName = 'DynamicField';

// --- Image field component ---

type ImageFieldProps = FieldProps & {
  maxImages: number;
};

const DynamicImageField = memo(({ fieldKey, prop, maxImages }: ImageFieldProps) => {
  const dispatch = useAppDispatch();
  const dynamicImageParams = useAppSelector(selectExternalApiDynamicImageParams);
  const imageNames = dynamicImageParams[fieldKey] ?? [];
  const isFull = imageNames.length >= maxImages;

  const dndTargetData = useMemo<AddDynamicSchemaImageDndTargetData>(
    () => addDynamicSchemaImageDndTarget.getData({ fieldKey }),
    [fieldKey]
  );

  const onClearAll = useCallback(() => {
    dispatch(externalApiDynamicImageFieldCleared(fieldKey));
  }, [dispatch, fieldKey]);

  return (
    <FormControl>
      <Flex alignItems="center" justifyContent="space-between">
        <FormLabel mb={0}>{prop.title ?? formatLabel(fieldKey)}</FormLabel>
        {imageNames.length > 0 && (
          <IconButton
            aria-label="Clear all"
            icon={<PiTrashSimpleBold />}
            size="xs"
            variant="ghost"
            onClick={onClearAll}
          />
        )}
      </Flex>
      <Flex
        position="relative"
        minH="72px"
        p={2}
        gap={2}
        borderWidth={1}
        borderRadius="md"
        borderColor="base.700"
        overflowX="auto"
        alignItems="center"
      >
        {imageNames.length === 0 && (
          <Text fontSize="xs" color="base.500" w="full" textAlign="center">
            {prop.description ?? 'Drop images here'}
          </Text>
        )}
        {imageNames.map((name) => (
          <DynamicImageThumbnail key={name} fieldKey={fieldKey} imageName={name} />
        ))}
        <DndDropTarget
          dndTarget={addDynamicSchemaImageDndTarget}
          dndTargetData={dndTargetData}
          label="Add image"
          isDisabled={isFull}
        />
      </Flex>
      {imageNames.length > 0 && (
        <Text fontSize="xs" color="base.500" mt={1}>
          {imageNames.length}/{maxImages} images
        </Text>
      )}
    </FormControl>
  );
});

DynamicImageField.displayName = 'DynamicImageField';

const DynamicImageThumbnail = memo(({ fieldKey, imageName }: { fieldKey: string; imageName: string }) => {
  const dispatch = useAppDispatch();
  const { data: imageDTO } = useGetImageDTOQuery(imageName);

  const onRemove = useCallback(() => {
    dispatch(externalApiDynamicImageRemoved({ fieldKey, imageName }));
  }, [dispatch, fieldKey, imageName]);

  if (!imageDTO) {
    return (
      <Box w="64px" h="64px" borderRadius="md" bg="base.700" flexShrink={0} position="relative">
        <DndImageIcon
          onClick={onRemove}
          icon={<PiTrashSimpleBold />}
          tooltip="Remove image"
          position="absolute"
          top={0}
          insetInlineEnd={0}
        />
      </Box>
    );
  }

  return (
    <Box w="64px" h="64px" flexShrink={0} position="relative">
      <DndImage
        imageDTO={imageDTO}
        asThumbnail
        objectFit="cover"
        w="full"
        h="full"
        borderRadius="md"
        backgroundSize={8}
        backgroundImage={TRANSPARENCY_CHECKERBOARD_PATTERN_DARK_DATAURL}
      />
      <DndImageIcon
        onClick={onRemove}
        icon={<PiTrashSimpleBold />}
        tooltip="Remove image"
        position="absolute"
        top={0}
        insetInlineEnd={0}
      />
    </Box>
  );
});

DynamicImageThumbnail.displayName = 'DynamicImageThumbnail';

// --- Scalar field components ---

const EnumField = memo(({ fieldKey, prop }: FieldProps) => {
  const dispatch = useAppDispatch();
  const dynamicParams = useAppSelector(selectExternalApiDynamicParams);
  const currentValue = (dynamicParams[fieldKey] as string) ?? (prop.default as string) ?? '';

  const options = useMemo((): ComboboxOption[] => {
    return (prop.enum ?? []).map((v) => ({
      value: String(v),
      label: String(v),
    }));
  }, [prop.enum]);

  const value = useMemo(() => options.find((o) => o.value === currentValue) ?? null, [options, currentValue]);

  const onChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (v) {
        dispatch(externalApiDynamicParamChanged({ key: fieldKey, value: v.value }));
      }
    },
    [dispatch, fieldKey]
  );

  return (
    <FormControl>
      <FormLabel>{prop.title ?? formatLabel(fieldKey)}</FormLabel>
      <Combobox value={value} options={options} onChange={onChange} />
    </FormControl>
  );
});

EnumField.displayName = 'EnumField';

const BooleanField = memo(({ fieldKey, prop }: FieldProps) => {
  const dispatch = useAppDispatch();
  const dynamicParams = useAppSelector(selectExternalApiDynamicParams);
  const currentValue = (dynamicParams[fieldKey] as boolean) ?? (prop.default as boolean) ?? false;

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      dispatch(externalApiDynamicParamChanged({ key: fieldKey, value: e.target.checked }));
    },
    [dispatch, fieldKey]
  );

  return (
    <FormControl>
      <FormLabel>{prop.title ?? formatLabel(fieldKey)}</FormLabel>
      <Switch isChecked={currentValue} onChange={onChange} />
    </FormControl>
  );
});

BooleanField.displayName = 'BooleanField';

const NumberField = memo(({ fieldKey, prop }: FieldProps) => {
  const dispatch = useAppDispatch();
  const dynamicParams = useAppSelector(selectExternalApiDynamicParams);
  const defaultVal = (prop.default as number) ?? 0;
  const currentValue = (dynamicParams[fieldKey] as number) ?? defaultVal;

  const min = prop.minimum ?? prop.exclusiveMinimum ?? (prop.type === 'integer' ? -999999 : -999999);
  const max = prop.maximum ?? prop.exclusiveMaximum ?? (prop.type === 'integer' ? 999999 : 999999);
  const step = prop.type === 'integer' ? 1 : 0.1;

  const onChange = useCallback(
    (v: number) => {
      dispatch(externalApiDynamicParamChanged({ key: fieldKey, value: v }));
    },
    [dispatch, fieldKey]
  );

  return (
    <FormControl>
      <FormLabel>{prop.title ?? formatLabel(fieldKey)}</FormLabel>
      <CompositeNumberInput
        value={currentValue}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        defaultValue={defaultVal}
      />
    </FormControl>
  );
});

NumberField.displayName = 'NumberField';

const StringField = memo(({ fieldKey, prop }: FieldProps) => {
  const dispatch = useAppDispatch();
  const dynamicParams = useAppSelector(selectExternalApiDynamicParams);
  const currentValue = (dynamicParams[fieldKey] as string) ?? (prop.default as string) ?? '';

  const onChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      dispatch(externalApiDynamicParamChanged({ key: fieldKey, value: e.target.value }));
    },
    [dispatch, fieldKey]
  );

  return (
    <FormControl>
      <FormLabel>{prop.title ?? formatLabel(fieldKey)}</FormLabel>
      <Input value={currentValue} onChange={onChange} size="sm" placeholder={prop.description ?? ''} />
    </FormControl>
  );
});

StringField.displayName = 'StringField';
