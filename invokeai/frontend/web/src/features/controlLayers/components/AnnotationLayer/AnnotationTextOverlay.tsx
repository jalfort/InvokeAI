import { useStore } from '@nanostores/react';
import { useAppSelector } from 'app/store/storeHooks';
import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import { useCanvasManager } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import {
  selectAnnotationColor,
  selectAnnotationFontFamily,
  selectAnnotationFontSize,
} from 'features/controlLayers/store/canvasSettingsSlice';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useRef } from 'react';

/**
 * DOM textarea overlay for on-canvas text editing.
 * Positioned absolutely over the canvas, matching zoom/pan via stage transforms.
 * Reads the text session nanostore from the annotation tool module.
 */
export const AnnotationTextOverlay = memo(() => {
  const canvasManager = useCanvasManager();
  const textSession = useStore(canvasManager.tool.tools.annotate.$textSession);
  const stageAttrs = useStore(canvasManager.stage.$stageAttrs);
  const annotationColor = useAppSelector(selectAnnotationColor);
  const fontSize = useAppSelector(selectAnnotationFontSize);
  const fontFamily = useAppSelector(selectAnnotationFontFamily);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus textarea when session starts
  useEffect(() => {
    if (textSession && textareaRef.current) {
      textareaRef.current.focus();
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
        canvasManager.tool.tools.annotate.cancelTextSession();
      }
    },
    [canvasManager]
  );

  const onBlur = useCallback(() => {
    canvasManager.tool.tools.annotate.commitTextSession();
  }, [canvasManager]);

  if (!textSession) {
    return null;
  }

  // Position the textarea in canvas-space coordinates, transformed to screen-space
  const screenX = textSession.position.x * stageAttrs.scale + stageAttrs.x;
  const screenY = textSession.position.y * stageAttrs.scale + stageAttrs.y;
  const scaledFontSize = fontSize * stageAttrs.scale;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 10,
      }}
    >
      <textarea
        ref={textareaRef}
        value={textSession.text}
        onChange={onTextChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        style={{
          position: 'absolute',
          left: screenX,
          top: screenY,
          pointerEvents: 'auto',
          fontSize: `${scaledFontSize}px`,
          fontFamily,
          color: rgbaColorToString(annotationColor),
          background: 'rgba(0, 0, 0, 0.6)',
          border: '1px solid rgba(255, 255, 255, 0.3)',
          borderRadius: '4px',
          padding: '4px 6px',
          minWidth: '120px',
          minHeight: `${scaledFontSize + 12}px`,
          resize: 'both',
          outline: 'none',
          lineHeight: 1.2,
          caretColor: rgbaColorToString(annotationColor),
        }}
        placeholder="Type text..."
      />
    </div>
  );
});

AnnotationTextOverlay.displayName = 'AnnotationTextOverlay';
