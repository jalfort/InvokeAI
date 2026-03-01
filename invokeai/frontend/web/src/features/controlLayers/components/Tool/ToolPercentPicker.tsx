import {
  CompositeNumberInput,
  CompositeSlider,
  Flex,
  FormControl,
  IconButton,
  NumberInput,
  NumberInputField,
  Popover,
  PopoverAnchor,
  PopoverArrow,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Portal,
} from '@invoke-ai/ui-library';
import { clamp } from 'es-toolkit/compat';
import type { FocusEvent, KeyboardEvent, PointerEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PiCaretDownBold } from 'react-icons/pi';

const formatPct = (v: number | string) => `${v} %`;

const SLIDER_VS_DROPDOWN_CONTAINER_WIDTH_THRESHOLD = 280;
const DEFAULT_PERCENT = 100;
const parseInputValue = (value: string) => Number.parseFloat(value);
const getInputValueFromEvent = (
  event?: Pick<FocusEvent<HTMLElement> | KeyboardEvent<HTMLElement>, 'target' | 'currentTarget'>
) => {
  const target = event?.target as HTMLInputElement | null;
  if (target?.tagName === 'INPUT') {
    return { input: target, parsed: parseInputValue(target.value) };
  }
  const currentTarget = event?.currentTarget as HTMLElement | null;
  const input = currentTarget?.querySelector('input') ?? null;
  return { input, parsed: input ? parseInputValue(input.value) : NaN };
};

interface PercentPickerComponentProps {
  localValue: number;
  min: number;
  defaultValue: number;
  marks: number[];
  onChangeSlider: (value: number) => void;
  onChangeInput: (value: number) => void;
  onBlur: (event?: FocusEvent<HTMLElement>) => void;
  onKeyDown: (value: KeyboardEvent<HTMLInputElement>) => void;
  onPointerDownCapture: (value: PointerEvent<HTMLDivElement>) => void;
  onPointerUpCapture: (value: PointerEvent<HTMLDivElement>) => void;
}

const DropDownPercentPickerComponent = memo(
  ({
    localValue,
    min,
    defaultValue,
    marks,
    onChangeSlider,
    onChangeInput,
    onKeyDown,
    onPointerDownCapture,
    onPointerUpCapture,
    onBlur,
  }: PercentPickerComponentProps) => {
    const onChangeNumberInput = useCallback(
      (valueAsString: string, valueAsNumber: number) => {
        onChangeInput(valueAsNumber);
      },
      [onChangeInput]
    );

    return (
      <Popover>
        <FormControl w="min-content" gap={2} overflow="hidden">
          <PopoverAnchor>
            <NumberInput
              variant="outline"
              display="flex"
              alignItems="center"
              min={min}
              max={100}
              value={localValue}
              onChange={onChangeNumberInput}
              onBlur={onBlur}
              w={76}
              format={formatPct}
              defaultValue={defaultValue}
              onKeyDown={onKeyDown}
              onPointerDownCapture={onPointerDownCapture}
              onPointerUpCapture={onPointerUpCapture}
              clampValueOnBlur={false}
            >
              <NumberInputField _focusVisible={{ zIndex: 0 }} title="" paddingInlineEnd={7} />
              <PopoverTrigger>
                <IconButton
                  aria-label="open-slider"
                  icon={<PiCaretDownBold />}
                  size="sm"
                  variant="link"
                  position="absolute"
                  insetInlineEnd={0}
                  h="full"
                />
              </PopoverTrigger>
            </NumberInput>
          </PopoverAnchor>
        </FormControl>
        <Portal>
          <PopoverContent w={200} pt={0} pb={2} px={4}>
            <PopoverArrow />
            <PopoverBody>
              <CompositeSlider
                min={min}
                max={100}
                value={localValue}
                onChange={onChangeSlider}
                defaultValue={defaultValue}
                marks={marks}
                formatValue={formatPct}
                alwaysShowMarks
              />
            </PopoverBody>
          </PopoverContent>
        </Portal>
      </Popover>
    );
  }
);
DropDownPercentPickerComponent.displayName = 'DropDownPercentPickerComponent';

const SliderPercentPickerComponent = memo(
  ({
    localValue,
    min,
    defaultValue,
    marks,
    onChangeSlider,
    onChangeInput,
    onKeyDown,
    onPointerDownCapture,
    onPointerUpCapture,
    onBlur,
  }: PercentPickerComponentProps) => {
    return (
      <Flex w={SLIDER_VS_DROPDOWN_CONTAINER_WIDTH_THRESHOLD} gap={4}>
        <CompositeSlider
          w={200}
          h="unset"
          min={min}
          max={100}
          value={localValue}
          onChange={onChangeSlider}
          defaultValue={defaultValue}
          marks={marks}
          formatValue={formatPct}
          alwaysShowMarks
        />
        <CompositeNumberInput
          w={28}
          variant="outline"
          min={min}
          max={100}
          value={localValue}
          onChange={onChangeInput}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          onPointerDownCapture={onPointerDownCapture}
          onPointerUpCapture={onPointerUpCapture}
          format={formatPct}
          defaultValue={defaultValue}
        />
      </Flex>
    );
  }
);
SliderPercentPickerComponent.displayName = 'SliderPercentPickerComponent';

interface ToolPercentPickerProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  defaultValue?: number;
}

export const ToolPercentPicker = memo(
  ({ value, onChange, min = 0, defaultValue = DEFAULT_PERCENT }: ToolPercentPickerProps) => {
    const ref = useRef<HTMLDivElement>(null);
    const [localValue, setLocalValue] = useState(value);
    const [componentType, setComponentType] = useState<'slider' | 'dropdown' | null>(null);
    const isTypingRef = useRef(false);
    const inputPollRef = useRef<number | null>(null);

    const marks = useMemo(() => [min, 50, 100], [min]);

    useEffect(() => {
      const el = ref.current;
      if (!el) {
        return;
      }
      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > SLIDER_VS_DROPDOWN_CONTAINER_WIDTH_THRESHOLD) {
            setComponentType('slider');
          } else {
            setComponentType('dropdown');
          }
        }
      });
      observer.observe(el);

      return () => {
        observer.disconnect();
      };
    }, []);

    const onClampedChange = useCallback(
      (v: number) => {
        onChange(clamp(Math.round(v), min, 100));
      },
      [onChange, min]
    );

    const syncFromInputElement = useCallback(
      (input: HTMLInputElement | null) => {
        if (!input) {
          return;
        }
        const parsed = parseInputValue(input.value);
        if (Number.isNaN(parsed)) {
          return;
        }
        setLocalValue(parsed);
        onClampedChange(parsed);
      },
      [onClampedChange]
    );

    const stopPollingInput = useCallback(() => {
      if (inputPollRef.current !== null) {
        window.clearInterval(inputPollRef.current);
        inputPollRef.current = null;
      }
    }, []);

    const startPollingInput = useCallback(
      (container: HTMLElement | null) => {
        stopPollingInput();
        if (!container) {
          return;
        }
        inputPollRef.current = window.setInterval(() => {
          const input = container.querySelector('input');
          if (!input) {
            return;
          }
          const parsed = parseInputValue(input.value);
          if (Number.isNaN(parsed)) {
            return;
          }
          setLocalValue(parsed);
          if (!isTypingRef.current) {
            onClampedChange(parsed);
          }
        }, 50);
      },
      [onClampedChange, stopPollingInput]
    );

    const commitValue = useCallback(
      (v: number) => {
        if (isNaN(Number(v))) {
          onClampedChange(defaultValue);
          setLocalValue(defaultValue);
        } else {
          onClampedChange(v);
          setLocalValue(v);
        }
      },
      [onClampedChange, defaultValue]
    );

    const onChangeSlider = useCallback(
      (v: number) => {
        onClampedChange(v);
      },
      [onClampedChange]
    );

    const onChangeInput = useCallback(
      (v: number) => {
        setLocalValue(v);
        if (!isNaN(v) && !isTypingRef.current) {
          onClampedChange(v);
        }
      },
      [onClampedChange]
    );

    const onBlur = useCallback(
      (event?: FocusEvent<HTMLElement>) => {
        const { parsed } = getInputValueFromEvent(event);
        commitValue(Number.isNaN(parsed) ? localValue : parsed);
        isTypingRef.current = false;
      },
      [commitValue, localValue]
    );

    const onKeyDown = useCallback(
      (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          const { parsed } = getInputValueFromEvent(e);
          commitValue(Number.isNaN(parsed) ? localValue : parsed);
          isTypingRef.current = false;
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          isTypingRef.current = false;
          const { input } = getInputValueFromEvent(e);
          window.requestAnimationFrame(() => {
            syncFromInputElement(input);
          });
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete' || e.key.length === 1) {
          isTypingRef.current = true;
        }
      },
      [commitValue, localValue, syncFromInputElement]
    );

    const onPointerDownCapture = useCallback(
      (_e: PointerEvent<HTMLDivElement>) => {
        isTypingRef.current = false;
        const target = _e.target as HTMLElement | null;
        if (target && target.tagName !== 'INPUT') {
          startPollingInput(_e.currentTarget);
        } else {
          stopPollingInput();
        }
      },
      [startPollingInput, stopPollingInput]
    );

    const onPointerUpCapture = useCallback(() => {
      stopPollingInput();
    }, [stopPollingInput]);

    useEffect(() => {
      setLocalValue(value);
    }, [value]);

    useEffect(() => {
      return () => {
        stopPollingInput();
      };
    }, [stopPollingInput]);

    return (
      <Flex
        ref={ref}
        alignItems="center"
        h="full"
        flexGrow={0}
        flexShrink={1}
        flexBasis="320px"
        minW="280px"
        justifyContent="flex-start"
        px={4}
      >
        {componentType === 'slider' && (
          <SliderPercentPickerComponent
            localValue={localValue}
            min={min}
            defaultValue={defaultValue}
            marks={marks}
            onChangeSlider={onChangeSlider}
            onChangeInput={onChangeInput}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            onPointerDownCapture={onPointerDownCapture}
            onPointerUpCapture={onPointerUpCapture}
          />
        )}
        {componentType === 'dropdown' && (
          <DropDownPercentPickerComponent
            localValue={localValue}
            min={min}
            defaultValue={defaultValue}
            marks={marks}
            onChangeSlider={onChangeSlider}
            onChangeInput={onChangeInput}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
            onPointerDownCapture={onPointerDownCapture}
            onPointerUpCapture={onPointerUpCapture}
          />
        )}
      </Flex>
    );
  }
);

ToolPercentPicker.displayName = 'ToolPercentPicker';
