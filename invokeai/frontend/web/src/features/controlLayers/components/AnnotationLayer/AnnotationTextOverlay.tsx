import { useStore } from '@nanostores/react';
import { createSelector } from '@reduxjs/toolkit';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import RgbaColorPicker from 'common/components/ColorPicker/RgbaColorPicker';
import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import { useCanvasManager } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import type { CanvasSettingsState } from 'features/controlLayers/store/canvasSettingsSlice';
import {
  selectAnnotationFontFamily,
  selectAnnotationFontSize,
  selectAnnotationFontStyle,
  selectAnnotationTextBgColor,
  selectAnnotationTextBgEnabled,
  selectCanvasSettingsSlice,
  settingsAnnotationFontSizeChanged,
  settingsAnnotationFontStyleChanged,
  settingsAnnotationTextBgColorChanged,
  settingsAnnotationTextBgEnabledToggled,
} from 'features/controlLayers/store/canvasSettingsSlice';
import type { RgbaColor } from 'features/controlLayers/store/types';
import type { ChangeEvent, FocusEvent, KeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  PiHighlighterCircleBold,
  PiTextBBold,
  PiTextItalicBold,
} from 'react-icons/pi';

// Local selector for the active fill color (same pattern as ToolFillColorPicker)
const selectActiveColor = createSelector(selectCanvasSettingsSlice, (settings) =>
  settings.activeColor === 'bgColor' ? settings.bgColor : settings.fgColor
);

/**
 * DOM textarea overlay for on-canvas text editing.
 * Positioned absolutely over the canvas, matching zoom/pan via stage transforms.
 * Includes a mini formatting toolbar below the textarea.
 */
export const AnnotationTextOverlay = memo(() => {
  const canvasManager = useCanvasManager();
  const dispatch = useAppDispatch();
  const textSession = useStore(canvasManager.tool.tools.annotate.$textSession);
  const stageAttrs = useStore(canvasManager.stage.$stageAttrs);
  const activeColor = useAppSelector(selectActiveColor);
  const fontSize = useAppSelector(selectAnnotationFontSize);
  const fontFamily = useAppSelector(selectAnnotationFontFamily);
  const fontStyle = useAppSelector(selectAnnotationFontStyle);
  const bgEnabled = useAppSelector(selectAnnotationTextBgEnabled);
  const bgColor = useAppSelector(selectAnnotationTextBgColor);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showBgPicker, setShowBgPicker] = useState(false);

  // Auto-focus textarea when session starts (delayed to avoid immediate blur from click event)
  useEffect(() => {
    if (textSession && textareaRef.current) {
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [textSession]);

  // Close bg picker when session ends
  useEffect(() => {
    if (!textSession) {
      setShowBgPicker(false);
    }
  }, [textSession]);

  const onTextChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const session = canvasManager.tool.tools.annotate.$textSession.get();
      if (session) {
        canvasManager.tool.tools.annotate.$textSession.set({ ...session, text: e.target.value });
      }
    },
    [canvasManager]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Stop all keyboard events from reaching the canvas tool module
      e.stopPropagation();

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        canvasManager.tool.tools.annotate.commitTextSession();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowBgPicker(false);
        canvasManager.tool.tools.annotate.cancelTextSession();
      }
    },
    [canvasManager]
  );

  const onBlur = useCallback(
    (_e: FocusEvent<HTMLTextAreaElement>) => {
      // Defer to next microtask so the browser updates document.activeElement.
      // This handles both toolbar buttons (which use preventDefault to keep focus)
      // and the color picker (which needs normal mouse interaction).
      setTimeout(() => {
        const container = containerRef.current;
        if (container && container.contains(document.activeElement)) {
          return; // Focus is still within our container (toolbar, picker, etc.)
        }
        // If text is empty, cancel instead of committing
        const session = canvasManager.tool.tools.annotate.$textSession.get();
        if (session && session.text.trim().length === 0) {
          canvasManager.tool.tools.annotate.cancelTextSession();
        } else {
          canvasManager.tool.tools.annotate.commitTextSession();
        }
      }, 0);
    },
    [canvasManager]
  );

  // Prevent toolbar clicks from stealing textarea focus
  const preventFocusLoss = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
  }, []);

  const toggleBold = useCallback(() => {
    const current = fontStyle;
    if (current.includes('bold')) {
      const next = current.replace('bold', '').trim() as CanvasSettingsState['annotationFontStyle'];
      dispatch(settingsAnnotationFontStyleChanged(next || 'normal'));
    } else {
      const next = current === 'normal' ? 'bold' : (`bold ${current}` as CanvasSettingsState['annotationFontStyle']);
      dispatch(settingsAnnotationFontStyleChanged(next));
    }
  }, [dispatch, fontStyle]);

  const toggleItalic = useCallback(() => {
    const current = fontStyle;
    if (current.includes('italic')) {
      const next = current.replace('italic', '').trim() as CanvasSettingsState['annotationFontStyle'];
      dispatch(settingsAnnotationFontStyleChanged(next || 'normal'));
    } else {
      const next = current === 'normal' ? 'italic' : (`${current} italic` as CanvasSettingsState['annotationFontStyle']);
      dispatch(settingsAnnotationFontStyleChanged(next));
    }
  }, [dispatch, fontStyle]);

  const toggleBg = useCallback(() => {
    dispatch(settingsAnnotationTextBgEnabledToggled());
  }, [dispatch]);

  const onBgColorChange = useCallback(
    (color: RgbaColor) => {
      dispatch(settingsAnnotationTextBgColorChanged(color));
    },
    [dispatch]
  );

  const onFontSizeChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val >= 8 && val <= 200) {
        dispatch(settingsAnnotationFontSizeChanged(val));
      }
    },
    [dispatch]
  );

  const toggleBgPicker = useCallback(() => {
    setShowBgPicker((prev) => !prev);
  }, []);

  if (!textSession) {
    return null;
  }

  // Position the textarea in canvas-space coordinates, transformed to screen-space
  const screenX = textSession.position.x * stageAttrs.scale + stageAttrs.x;
  const screenY = textSession.position.y * stageAttrs.scale + stageAttrs.y;
  const scaledFontSize = fontSize * stageAttrs.scale;
  const colorStr = rgbaColorToString(activeColor);
  const isBold = fontStyle.includes('bold');
  const isItalic = fontStyle.includes('italic');

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      <div
        ref={containerRef}
        style={{
          position: 'absolute',
          left: screenX,
          top: screenY,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          pointerEvents: 'auto',
        }}
      >
        <textarea
          ref={textareaRef}
          value={textSession.text}
          onChange={onTextChange}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          style={{
            fontSize: `${scaledFontSize}px`,
            fontFamily,
            fontWeight: isBold ? 'bold' : 'normal',
            fontStyle: isItalic ? 'italic' : 'normal',
            color: colorStr,
            background: bgEnabled ? rgbaColorToString(bgColor) : 'rgba(0, 0, 0, 0.3)',
            border: '1px solid rgba(255, 255, 255, 0.3)',
            borderRadius: '4px',
            padding: '4px 6px',
            minWidth: '120px',
            minHeight: `${scaledFontSize + 12}px`,
            resize: 'both',
            outline: 'none',
            lineHeight: 1.2,
            caretColor: colorStr,
          }}
          placeholder="Type text..."
        />

        {/* Mini formatting toolbar */}
        <div
          onMouseDown={preventFocusLoss}
          onPointerDown={preventFocusLoss}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            background: 'var(--invoke-colors-base-800)',
            borderRadius: 6,
            padding: '3px 6px',
            border: '1px solid var(--invoke-colors-base-600)',
            userSelect: 'none',
          }}
        >
          {/* Bold */}
          <button
            onClick={toggleBold}
            title="Bold"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: isBold ? 'var(--invoke-colors-invokeBlue-700)' : 'transparent',
              color: isBold ? 'white' : 'var(--invoke-colors-base-300)',
            }}
          >
            <PiTextBBold size={14} />
          </button>

          {/* Italic */}
          <button
            onClick={toggleItalic}
            title="Italic"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: isItalic ? 'var(--invoke-colors-invokeBlue-700)' : 'transparent',
              color: isItalic ? 'white' : 'var(--invoke-colors-base-300)',
            }}
          >
            <PiTextItalicBold size={14} />
          </button>

          {/* Separator */}
          <div style={{ width: 1, height: 18, background: 'var(--invoke-colors-base-600)', margin: '0 2px' }} />

          {/* BG toggle + swatch */}
          <button
            onClick={toggleBg}
            title="Background"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 4,
              border: 'none',
              cursor: 'pointer',
              background: bgEnabled ? 'var(--invoke-colors-invokeBlue-700)' : 'transparent',
              color: bgEnabled ? 'white' : 'var(--invoke-colors-base-300)',
            }}
          >
            <PiHighlighterCircleBold size={14} />
          </button>

          {bgEnabled && (
            <button
              onClick={toggleBgPicker}
              title="Background Color"
              style={{
                width: 18,
                height: 18,
                borderRadius: 3,
                border: '1px solid var(--invoke-colors-base-500)',
                cursor: 'pointer',
                background: rgbaColorToString(bgColor),
                padding: 0,
              }}
            />
          )}

          {/* Separator */}
          <div style={{ width: 1, height: 18, background: 'var(--invoke-colors-base-600)', margin: '0 2px' }} />

          {/* Font size */}
          <input
            type="number"
            min={8}
            max={200}
            step={2}
            value={fontSize}
            onChange={onFontSizeChange}
            style={{
              width: 44,
              height: 26,
              borderRadius: 4,
              border: '1px solid var(--invoke-colors-base-600)',
              background: 'var(--invoke-colors-base-900)',
              color: 'var(--invoke-colors-base-200)',
              textAlign: 'center',
              fontSize: 12,
              outline: 'none',
              padding: '0 2px',
            }}
          />
          <span style={{ fontSize: 10, color: 'var(--invoke-colors-base-400)' }}>pt</span>
        </div>

        {/* BG color picker (shown when swatch is clicked) */}
        {showBgPicker && bgEnabled && (
          <div
            style={{
              background: 'var(--invoke-colors-base-800)',
              borderRadius: 8,
              padding: 12,
              border: '1px solid var(--invoke-colors-base-600)',
            }}
          >
            <RgbaColorPicker color={bgColor} onChange={onBgColorChange} withNumberInput withSwatches />
          </div>
        )}
      </div>
    </div>
  );
});

AnnotationTextOverlay.displayName = 'AnnotationTextOverlay';
