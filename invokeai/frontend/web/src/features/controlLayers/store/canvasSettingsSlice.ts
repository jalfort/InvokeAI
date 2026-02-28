import type { PayloadAction, Selector } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { RootState } from 'app/store/store';
import type { SliceConfig } from 'app/store/types';
import type { RgbaColor, RgbColor } from 'features/controlLayers/store/types';
import { RGBA_BLACK, RGBA_WHITE, zRgbaColor } from 'features/controlLayers/store/types';
import { z } from 'zod';

const zAutoSwitchMode = z.enum(['off', 'switch_on_start', 'switch_on_finish']);
export type AutoSwitchMode = z.infer<typeof zAutoSwitchMode>;

const zTransformSmoothingMode = z.enum(['bilinear', 'bicubic', 'hamming', 'lanczos']);
export type TransformSmoothingMode = z.infer<typeof zTransformSmoothingMode>;

const zGradientType = z.enum(['linear', 'radial']);

const zSelectionMode = z.enum(['rectangle', 'ellipse', 'lasso', 'polygon']);
export type SelectionMode = z.infer<typeof zSelectionMode>;

const zAnnotationMode = z.enum(['select', 'line', 'arrow', 'text', 'rect', 'ellipse']);
export type AnnotationMode = z.infer<typeof zAnnotationMode>;

const zSelectionFeatherDirection = z.enum(['both', 'inward', 'outward']);
export type SelectionFeatherDirection = z.infer<typeof zSelectionFeatherDirection>;

const zCanvasSettingsState = z.object({
  /**
   * Whether to show HUD (Heads-Up Display) on the canvas.
   */
  showHUD: z.boolean(),
  /**
   * Whether to clip lines and shapes to the generation bounding box. If disabled, lines and shapes will be clipped to
   * the canvas bounds.
   */
  clipToBbox: z.boolean(),
  /**
   * Whether to show a dynamic grid on the canvas. If disabled, a checkerboard pattern will be shown instead.
   */
  dynamicGrid: z.boolean(),
  /**
   * Whether to invert the scroll direction when adjusting the brush or eraser width with the scroll wheel.
   */
  invertScrollForToolWidth: z.boolean(),
  /**
   * The width of the brush tool.
   */
  brushWidth: z.int().gt(0),
  /**
   * The hardness of the brush tool (0 = fully soft Gaussian, 1 = hard edge).
   */
  brushHardness: z.number().min(0).max(1).default(1),
  /**
   * The per-stroke opacity of the brush tool (0 = fully transparent, 1 = fully opaque).
   */
  brushOpacity: z.number().min(0).max(1).default(1),
  /**
   * The width of the eraser tool.
   */
  eraserWidth: z.int().gt(0),
  /**
   * The colors to use when drawing lines or filling shapes.
   */
  activeColor: z.enum(['bgColor', 'fgColor']),
  bgColor: zRgbaColor,
  fgColor: zRgbaColor,
  /**
   * Whether to composite inpainted/outpainted regions back onto the source image when saving canvas generations.
   *
   * If disabled, inpainted/outpainted regions will be saved with a transparent background.
   *
   * When `sendToCanvas` is disabled, this setting is ignored, masked regions will always be composited.
   */
  outputOnlyMaskedRegions: z.boolean(),
  /**
   * Whether to automatically process the operations like filtering and auto-masking.
   */
  autoProcess: z.boolean(),
  /**
   * The snap-to-grid setting for the canvas.
   */
  snapToGrid: z.boolean(),
  /**
   * Whether to show progress on the canvas when generating images.
   */
  showProgressOnCanvas: z.boolean(),
  /**
   * Whether to show the bounding box overlay on the canvas.
   */
  bboxOverlay: z.boolean(),
  /**
   * Whether to preserve the masked region instead of inpainting it.
   */
  preserveMask: z.boolean(),
  /**
   * Whether to show only raster layers while staging.
   */
  isolatedStagingPreview: z.boolean(),
  /**
   * Whether to show only the selected layer while filtering, transforming, or doing other operations.
   */
  isolatedLayerPreview: z.boolean(),
  /**
   * Whether to use pressure sensitivity for the brush and eraser tool when a pen device is used.
   */
  pressureSensitivity: z.boolean(),
  /**
   * Whether to show the rule of thirds composition guide overlay on the canvas.
   */
  ruleOfThirds: z.boolean(),
  /**
   * Whether to apply smoothing when rasterizing transformed layers.
   */
  transformSmoothingEnabled: z.boolean().default(false),
  /**
   * The resampling mode to use when smoothing transformed layers.
   */
  transformSmoothingMode: zTransformSmoothingMode.default('bicubic'),
  /**
   * Whether to save all staging images to the gallery instead of keeping them as intermediate images.
   */
  saveAllImagesToGallery: z.boolean(),
  /**
   * The auto-switch mode for the canvas staging area.
   */
  stagingAreaAutoSwitch: zAutoSwitchMode,
  /**
   * Whether the fill color picker UI is pinned (persistently shown in the canvas overlay).
   */
  fillColorPickerPinned: z.boolean(),
  /**
   * The gradient tool type.
   */
  gradientType: zGradientType.default('linear'),
  /**
   * Whether the gradient tool clips to the drag gesture.
   */
  gradientClipEnabled: z.boolean().default(true),
  /**
   * The selection tool shape mode.
   */
  selectionMode: zSelectionMode.default('rectangle'),
  /**
   * The feather radius for selection operations (0-100px).
   */
  selectionFeatherRadius: z.number().min(0).default(0),
  /**
   * The feather direction for selection operations.
   */
  selectionFeatherDirection: zSelectionFeatherDirection.default('both'),
  /**
   * Whether the clone brush uses aligned mode (offset persists across strokes).
   */
  cloneBrushAlignedMode: z.boolean().default(true),
  /**
   * The clone brush sampling mode: current layer only, or current layer and all visible layers below.
   */
  cloneBrushSampleMode: z.enum(['current_layer', 'current_and_below']).default('current_layer'),
  /**
   * The opacity of the selection overlay (0-1).
   */
  selectionOverlayOpacity: z.number().min(0).max(1).default(0.5),
  /**
   * The color of the selection overlay.
   */
  selectionOverlayColor: z
    .object({
      r: z.number().int().min(0).max(255),
      g: z.number().int().min(0).max(255),
      b: z.number().int().min(0).max(255),
    })
    .default({ r: 220, g: 40, b: 40 }),
  /**
   * The annotation tool sub-tool mode.
   */
  annotationMode: zAnnotationMode.default('arrow'),
  /**
   * The annotation stroke width for line/arrow/rect/ellipse.
   */
  annotationStrokeWidth: z.number().min(1).max(50).default(3),
  /**
   * The annotation text font size.
   */
  annotationFontSize: z.number().min(8).max(200).default(16),
  /**
   * The annotation text font family.
   */
  annotationFontFamily: z.string().default('sans-serif'),
  /**
   * The annotation text font style (normal, bold, italic, bold italic).
   */
  annotationFontStyle: z.enum(['normal', 'bold', 'italic', 'bold italic']).default('normal'),
  /**
   * Whether text annotations have a background rectangle.
   */
  annotationTextBgEnabled: z.boolean().default(true),
  /**
   * The annotation text background color (RGBA, alpha = opacity).
   */
  annotationTextBgColor: zRgbaColor.default({ r: 0, g: 0, b: 0, a: 0.8 }),
});

export type CanvasSettingsState = z.infer<typeof zCanvasSettingsState>;
const getInitialState = (): CanvasSettingsState => ({
  showHUD: true,
  clipToBbox: false,
  dynamicGrid: false,
  invertScrollForToolWidth: false,
  brushWidth: 50,
  brushHardness: 1,
  brushOpacity: 1,
  eraserWidth: 50,
  activeColor: 'fgColor',
  bgColor: RGBA_BLACK,
  fgColor: RGBA_WHITE,
  outputOnlyMaskedRegions: true,
  autoProcess: true,
  snapToGrid: true,
  showProgressOnCanvas: true,
  bboxOverlay: false,
  preserveMask: false,
  isolatedStagingPreview: true,
  isolatedLayerPreview: true,
  pressureSensitivity: true,
  ruleOfThirds: false,
  saveAllImagesToGallery: false,
  stagingAreaAutoSwitch: 'switch_on_start',
  fillColorPickerPinned: false,
  transformSmoothingEnabled: false,
  transformSmoothingMode: 'bicubic',
  gradientType: 'linear',
  gradientClipEnabled: true,
  cloneBrushAlignedMode: true,
  cloneBrushSampleMode: 'current_layer',
  selectionMode: 'rectangle',
  selectionFeatherRadius: 0,
  selectionFeatherDirection: 'both',
  selectionOverlayOpacity: 0.5,
  selectionOverlayColor: { r: 220, g: 40, b: 40 },
  annotationMode: 'arrow',
  annotationStrokeWidth: 3,
  annotationFontSize: 16,
  annotationFontFamily: 'sans-serif',
  annotationFontStyle: 'normal' as const,
  annotationTextBgEnabled: true,
  annotationTextBgColor: { r: 0, g: 0, b: 0, a: 0.8 },
});

const slice = createSlice({
  name: 'canvasSettings',
  initialState: getInitialState(),
  reducers: {
    settingsClipToBboxChanged: (state, action: PayloadAction<CanvasSettingsState['clipToBbox']>) => {
      state.clipToBbox = action.payload;
    },
    settingsDynamicGridToggled: (state) => {
      state.dynamicGrid = !state.dynamicGrid;
    },
    settingsShowHUDToggled: (state) => {
      state.showHUD = !state.showHUD;
    },
    settingsBrushWidthChanged: (state, action: PayloadAction<CanvasSettingsState['brushWidth']>) => {
      state.brushWidth = Math.round(action.payload);
    },
    settingsBrushHardnessChanged: (state, action: PayloadAction<CanvasSettingsState['brushHardness']>) => {
      state.brushHardness = action.payload;
    },
    settingsBrushOpacityChanged: (state, action: PayloadAction<CanvasSettingsState['brushOpacity']>) => {
      state.brushOpacity = action.payload;
    },
    settingsEraserWidthChanged: (state, action: PayloadAction<CanvasSettingsState['eraserWidth']>) => {
      state.eraserWidth = Math.round(action.payload);
    },
    settingsActiveColorToggled: (state) => {
      state.activeColor = state.activeColor === 'bgColor' ? 'fgColor' : 'bgColor';
    },
    settingsBgColorChanged: (state, action: PayloadAction<Partial<RgbaColor>>) => {
      state.bgColor = { ...state.bgColor, ...action.payload };
    },
    settingsFgColorChanged: (state, action: PayloadAction<Partial<RgbaColor>>) => {
      state.fgColor = { ...state.fgColor, ...action.payload };
    },
    settingsColorsSetToDefault: (state) => {
      state.bgColor = RGBA_BLACK;
      state.fgColor = RGBA_WHITE;
    },
    settingsInvertScrollForToolWidthChanged: (
      state,
      action: PayloadAction<CanvasSettingsState['invertScrollForToolWidth']>
    ) => {
      state.invertScrollForToolWidth = action.payload;
    },
    settingsOutputOnlyMaskedRegionsToggled: (state) => {
      state.outputOnlyMaskedRegions = !state.outputOnlyMaskedRegions;
    },
    settingsAutoProcessToggled: (state) => {
      state.autoProcess = !state.autoProcess;
    },
    settingsSnapToGridToggled: (state) => {
      state.snapToGrid = !state.snapToGrid;
    },
    settingsShowProgressOnCanvasToggled: (state) => {
      state.showProgressOnCanvas = !state.showProgressOnCanvas;
    },
    settingsBboxOverlayToggled: (state) => {
      state.bboxOverlay = !state.bboxOverlay;
    },
    settingsPreserveMaskToggled: (state) => {
      state.preserveMask = !state.preserveMask;
    },
    settingsIsolatedStagingPreviewToggled: (state) => {
      state.isolatedStagingPreview = !state.isolatedStagingPreview;
    },
    settingsIsolatedLayerPreviewToggled: (state) => {
      state.isolatedLayerPreview = !state.isolatedLayerPreview;
    },
    settingsPressureSensitivityToggled: (state) => {
      state.pressureSensitivity = !state.pressureSensitivity;
    },
    settingsRuleOfThirdsToggled: (state) => {
      state.ruleOfThirds = !state.ruleOfThirds;
    },
    settingsSaveAllImagesToGalleryToggled: (state) => {
      state.saveAllImagesToGallery = !state.saveAllImagesToGallery;
    },
    settingsTransformSmoothingEnabledToggled: (state) => {
      state.transformSmoothingEnabled = !state.transformSmoothingEnabled;
    },
    settingsTransformSmoothingModeChanged: (
      state,
      action: PayloadAction<CanvasSettingsState['transformSmoothingMode']>
    ) => {
      state.transformSmoothingMode = action.payload;
    },
    settingsStagingAreaAutoSwitchChanged: (
      state,
      action: PayloadAction<CanvasSettingsState['stagingAreaAutoSwitch']>
    ) => {
      state.stagingAreaAutoSwitch = action.payload;
    },
    settingsFillColorPickerPinnedSet: (state, action: PayloadAction<boolean>) => {
      state.fillColorPickerPinned = action.payload;
    },
    settingsGradientTypeChanged: (state, action: PayloadAction<CanvasSettingsState['gradientType']>) => {
      state.gradientType = action.payload;
    },
    settingsGradientClipToggled: (state) => {
      state.gradientClipEnabled = !state.gradientClipEnabled;
    },
    settingsCloneBrushAlignedModeToggled: (state) => {
      state.cloneBrushAlignedMode = !state.cloneBrushAlignedMode;
    },
    settingsCloneBrushSampleModeChanged: (
      state,
      action: PayloadAction<CanvasSettingsState['cloneBrushSampleMode']>
    ) => {
      state.cloneBrushSampleMode = action.payload;
    },
    settingsSelectionModeChanged: (state, action: PayloadAction<CanvasSettingsState['selectionMode']>) => {
      state.selectionMode = action.payload;
    },
    settingsSelectionFeatherRadiusChanged: (
      state,
      action: PayloadAction<CanvasSettingsState['selectionFeatherRadius']>
    ) => {
      state.selectionFeatherRadius = action.payload;
    },
    settingsSelectionFeatherDirectionChanged: (
      state,
      action: PayloadAction<CanvasSettingsState['selectionFeatherDirection']>
    ) => {
      state.selectionFeatherDirection = action.payload;
    },
    settingsSelectionOverlayOpacityChanged: (
      state,
      action: PayloadAction<CanvasSettingsState['selectionOverlayOpacity']>
    ) => {
      state.selectionOverlayOpacity = action.payload;
    },
    settingsSelectionOverlayColorChanged: (state, action: PayloadAction<RgbColor>) => {
      state.selectionOverlayColor = action.payload;
    },
    settingsAnnotationModeChanged: (state, action: PayloadAction<CanvasSettingsState['annotationMode']>) => {
      state.annotationMode = action.payload;
    },
    settingsAnnotationStrokeWidthChanged: (state, action: PayloadAction<CanvasSettingsState['annotationStrokeWidth']>) => {
      state.annotationStrokeWidth = action.payload;
    },
    settingsAnnotationFontSizeChanged: (state, action: PayloadAction<CanvasSettingsState['annotationFontSize']>) => {
      state.annotationFontSize = action.payload;
    },
    settingsAnnotationFontFamilyChanged: (state, action: PayloadAction<CanvasSettingsState['annotationFontFamily']>) => {
      state.annotationFontFamily = action.payload;
    },
    settingsAnnotationFontStyleChanged: (state, action: PayloadAction<CanvasSettingsState['annotationFontStyle']>) => {
      state.annotationFontStyle = action.payload;
    },
    settingsAnnotationTextBgEnabledToggled: (state) => {
      state.annotationTextBgEnabled = !state.annotationTextBgEnabled;
    },
    settingsAnnotationTextBgColorChanged: (state, action: PayloadAction<RgbaColor>) => {
      state.annotationTextBgColor = action.payload;
    },
  },
});

export const {
  settingsClipToBboxChanged,
  settingsDynamicGridToggled,
  settingsShowHUDToggled,
  settingsBrushWidthChanged,
  settingsBrushHardnessChanged,
  settingsBrushOpacityChanged,
  settingsEraserWidthChanged,
  settingsActiveColorToggled,
  settingsBgColorChanged,
  settingsFgColorChanged,
  settingsColorsSetToDefault,
  settingsInvertScrollForToolWidthChanged,
  settingsOutputOnlyMaskedRegionsToggled,
  settingsAutoProcessToggled,
  settingsSnapToGridToggled,
  settingsShowProgressOnCanvasToggled,
  settingsBboxOverlayToggled,
  settingsPreserveMaskToggled,
  settingsIsolatedStagingPreviewToggled,
  settingsIsolatedLayerPreviewToggled,
  settingsPressureSensitivityToggled,
  settingsRuleOfThirdsToggled,
  settingsSaveAllImagesToGalleryToggled,
  settingsTransformSmoothingEnabledToggled,
  settingsTransformSmoothingModeChanged,
  settingsStagingAreaAutoSwitchChanged,
  settingsFillColorPickerPinnedSet,
  settingsGradientTypeChanged,
  settingsGradientClipToggled,
  settingsCloneBrushAlignedModeToggled,
  settingsCloneBrushSampleModeChanged,
  settingsSelectionModeChanged,
  settingsSelectionFeatherRadiusChanged,
  settingsSelectionFeatherDirectionChanged,
  settingsSelectionOverlayOpacityChanged,
  settingsSelectionOverlayColorChanged,
  settingsAnnotationModeChanged,
  settingsAnnotationStrokeWidthChanged,
  settingsAnnotationFontSizeChanged,
  settingsAnnotationFontFamilyChanged,
  settingsAnnotationFontStyleChanged,
  settingsAnnotationTextBgEnabledToggled,
  settingsAnnotationTextBgColorChanged,
} = slice.actions;

export const canvasSettingsSliceConfig: SliceConfig<typeof slice> = {
  slice,
  schema: zCanvasSettingsState,
  getInitialState,
  persistConfig: {
    migrate: (state) => zCanvasSettingsState.parse(state),
  },
};

export const selectCanvasSettingsSlice = (s: RootState) => s.canvasSettings;
const createCanvasSettingsSelector = <T>(selector: Selector<CanvasSettingsState, T>) =>
  createSelector(selectCanvasSettingsSlice, selector);

export const selectFillColorPickerPinned = createCanvasSettingsSelector((s) => s.fillColorPickerPinned);

export const selectPreserveMask = createCanvasSettingsSelector((settings) => settings.preserveMask);
export const selectOutputOnlyMaskedRegions = createCanvasSettingsSelector(
  (settings) => settings.outputOnlyMaskedRegions
);
export const selectDynamicGrid = createCanvasSettingsSelector((settings) => settings.dynamicGrid);
export const selectBboxOverlay = createCanvasSettingsSelector((settings) => settings.bboxOverlay);
export const selectShowHUD = createCanvasSettingsSelector((settings) => settings.showHUD);
export const selectAutoProcess = createCanvasSettingsSelector((settings) => settings.autoProcess);
export const selectSnapToGrid = createCanvasSettingsSelector((settings) => settings.snapToGrid);
export const selectShowProgressOnCanvas = createCanvasSettingsSelector(
  (canvasSettings) => canvasSettings.showProgressOnCanvas
);
export const selectIsolatedStagingPreview = createCanvasSettingsSelector((settings) => settings.isolatedStagingPreview);
export const selectIsolatedLayerPreview = createCanvasSettingsSelector((settings) => settings.isolatedLayerPreview);
export const selectPressureSensitivity = createCanvasSettingsSelector((settings) => settings.pressureSensitivity);
export const selectRuleOfThirds = createCanvasSettingsSelector((settings) => settings.ruleOfThirds);
export const selectSaveAllImagesToGallery = createCanvasSettingsSelector((settings) => settings.saveAllImagesToGallery);
export const selectStagingAreaAutoSwitch = createCanvasSettingsSelector((settings) => settings.stagingAreaAutoSwitch);
export const selectTransformSmoothingEnabled = createCanvasSettingsSelector(
  (settings) => settings.transformSmoothingEnabled
);
export const selectTransformSmoothingMode = createCanvasSettingsSelector((settings) => settings.transformSmoothingMode);
export const selectGradientType = createCanvasSettingsSelector((settings) => settings.gradientType);
export const selectGradientClipEnabled = createCanvasSettingsSelector((settings) => settings.gradientClipEnabled);
export const selectSelectionMode = createCanvasSettingsSelector((settings) => settings.selectionMode);
export const selectSelectionFeatherRadius = createCanvasSettingsSelector((settings) => settings.selectionFeatherRadius);
export const selectSelectionFeatherDirection = createCanvasSettingsSelector(
  (settings) => settings.selectionFeatherDirection
);
export const selectSelectionOverlayOpacity = createCanvasSettingsSelector(
  (settings) => settings.selectionOverlayOpacity
);
export const selectSelectionOverlayColor = createCanvasSettingsSelector((settings) => settings.selectionOverlayColor);
export const selectBrushHardness = createCanvasSettingsSelector((settings) => settings.brushHardness);
export const selectBrushOpacity = createCanvasSettingsSelector((settings) => settings.brushOpacity);
export const selectCloneBrushAlignedMode = createCanvasSettingsSelector((settings) => settings.cloneBrushAlignedMode);
export const selectCloneBrushSampleMode = createCanvasSettingsSelector((settings) => settings.cloneBrushSampleMode);
export const selectAnnotationMode = createCanvasSettingsSelector((settings) => settings.annotationMode);
export const selectAnnotationStrokeWidth = createCanvasSettingsSelector((settings) => settings.annotationStrokeWidth);
export const selectAnnotationFontSize = createCanvasSettingsSelector((settings) => settings.annotationFontSize);
export const selectAnnotationFontFamily = createCanvasSettingsSelector((settings) => settings.annotationFontFamily);
export const selectAnnotationFontStyle = createCanvasSettingsSelector((settings) => settings.annotationFontStyle);
export const selectAnnotationTextBgEnabled = createCanvasSettingsSelector((settings) => settings.annotationTextBgEnabled);
export const selectAnnotationTextBgColor = createCanvasSettingsSelector((settings) => settings.annotationTextBgColor);
