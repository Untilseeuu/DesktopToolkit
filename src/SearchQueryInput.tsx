import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";

const SEARCH_INPUT_DEBOUNCE_MS = 80;

type SearchQueryInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "onSubmit" | "value"
> & {
  onSearchChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  resetSignal?: number;
  showClear?: boolean;
};

export const SearchQueryInput = forwardRef<
  HTMLInputElement,
  SearchQueryInputProps
>(function SearchQueryInput(
  {
    onSearchChange,
    onSubmit,
    onKeyDown,
    resetSignal,
    showClear = false,
    ...inputProps
  },
  forwardedRef,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | null>(null);
  const [value, setValue] = useState("");
  const valueRef = useRef("");

  useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(
    (nextValue: string) => {
      cancelPending();
      onSearchChange(nextValue);
    },
    [cancelPending, onSearchChange],
  );

  const schedule = useCallback(
    (nextValue: string) => {
      cancelPending();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        onSearchChange(nextValue);
      }, SEARCH_INPUT_DEBOUNCE_MS);
    },
    [cancelPending, onSearchChange],
  );

  useEffect(() => cancelPending, [cancelPending]);

  useEffect(() => {
    if (resetSignal === undefined) return;
    valueRef.current = "";
    setValue("");
    cancelPending();
  }, [cancelPending, resetSignal]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Enter") return;
    flush(valueRef.current);
    onSubmit?.(valueRef.current);
  };

  const clear = () => {
    valueRef.current = "";
    setValue("");
    flush("");
    inputRef.current?.focus();
  };

  return (
    <>
      <input
        {...inputProps}
        ref={inputRef}
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          valueRef.current = nextValue;
          setValue(nextValue);
          schedule(nextValue);
        }}
        onKeyDown={handleKeyDown}
      />
      {showClear && value ? (
        <button
          type="button"
          className="search-query-clear"
          aria-label="清空搜索"
          onClick={clear}
        >
          ×
        </button>
      ) : null}
    </>
  );
});
