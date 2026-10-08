"use client";

import type { ComponentProps } from "react";
import { useRef, useSyncExternalStore } from "react";
import { isSelectStepKey } from "@/components/desk-location-select";

const subscribeNever = () => () => {};

/**
 * A plain GET form whose selects submit it as soon as a choice is made. Without
 * scripts it is an ordinary form and its submit button (mark it
 * `auto-submit-go`) shows. With scripts the button is visually hidden but stays
 * in the keyboard order (it shows again when focused). Keyboard steps through a
 * closed select wait for Enter or the button, as DeskLocationSelect does (#413),
 * so arrowing past a choice does not reload the page.
 */
export function AutoSubmitForm({ className, onChange, onKeyDown, onPointerDown, ...props }: ComponentProps<"form">) {
  // False on the server and during hydration, true once scripts run.
  const enhanced = useSyncExternalStore(subscribeNever, () => true, () => false);
  const steppedByKeyboard = useRef(false);
  const recentlySubmitted = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  // One submission per choice, even if both a change and an Enter ask for it.
  function submitOnce() {
    if (recentlySubmitted.current) return;
    recentlySubmitted.current = true;
    setTimeout(() => { recentlySubmitted.current = false; }, 300);
    formRef.current?.requestSubmit();
  }
  return (
    <form
      {...props}
      className={[className, enhanced ? "auto-submit-enhanced" : ""].filter(Boolean).join(" ")}
      onChange={(event) => {
        onChange?.(event);
        if (!(event.target instanceof HTMLSelectElement)) return;
        const keyboard = steppedByKeyboard.current;
        steppedByKeyboard.current = false;
        if (enhanced && !keyboard) submitOnce();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!(event.target instanceof HTMLSelectElement)) return;
        if (event.key === "Enter") {
          // No preventDefault: with the list open the browser still commits the pick.
          steppedByKeyboard.current = false;
          if (enhanced) setTimeout(submitOnce, 0);
        } else steppedByKeyboard.current = isSelectStepKey(event.key);
      }}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        steppedByKeyboard.current = false;
      }}
      ref={formRef}
    />
  );
}
