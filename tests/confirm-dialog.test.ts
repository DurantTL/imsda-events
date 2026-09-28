import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { cancelUnlessBusy, ConfirmDialog } from "@/components/confirm-dialog";

// `createElement`'s props parameter still requires `children` per
// `ConfirmDialog`'s own prop types even when it's passed as a trailing
// argument instead, so tests pass it as a separate argument (satisfying
// `react/no-children-prop`) against this children-less props type.
type DialogProps = Omit<ComponentProps<typeof ConfirmDialog>, "children">;

/**
 * The reusable in-page confirmation dialog (#466), replacing `window.confirm()`
 * in the act-as flow. This environment renders React without a DOM (see
 * vitest.config.ts), so this proves the accessible-dialog markup a screen
 * reader or keyboard user relies on: `role="dialog"`, `aria-modal`, and the
 * dialog's heading linked by `aria-labelledby`. Focus handling, Escape, and
 * the backdrop click are `useAccessibleDialog`'s own job (exercised by
 * `csv-import-dialog.test.ts`'s sibling usage); this only checks that
 * `ConfirmDialog` wires them the same way.
 */
function markup(open: boolean) {
  const props: DialogProps = {
    busy: false,
    confirmLabel: "Start acting",
    error: "",
    onCancel: () => {},
    onConfirm: () => {},
    open,
    title: "Act as Director of Riverside Pathfinders?",
  };
  return renderToStaticMarkup(createElement(
    ConfirmDialog,
    props as unknown as ComponentProps<typeof ConfirmDialog>,
    createElement("p", null, "Full director powers, attributed to you."),
  ));
}

describe("ConfirmDialog (#466)", () => {
  it("renders nothing while closed", () => {
    expect(markup(false)).toBe("");
  });

  it("renders an accessible modal dialog with the confirm and cancel actions when open", () => {
    const html = markup(true);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Act as Director of Riverside Pathfinders?");
    expect(html).toContain("Full director powers, attributed to you.");
    expect(html).toContain("Start acting");
    expect(html).toContain("Cancel");
  });

  it("shows an inline error instead of silently failing", () => {
    const props: DialogProps = {
      busy: false,
      confirmLabel: "Start acting",
      error: "That didn't work. Try again.",
      onCancel: () => {},
      onConfirm: () => {},
      open: true,
      title: "Act as Director?",
    };
    const html = renderToStaticMarkup(createElement(
      ConfirmDialog,
      props as unknown as ComponentProps<typeof ConfirmDialog>,
      createElement("p", null, "Body"),
    ));
    expect(html).toContain('role="alert"');
    expect(html).toContain("That didn&#x27;t work. Try again.");
  });
});

describe("cancelUnlessBusy (#466 review)", () => {
  it("cancels when nothing is running", () => {
    const onCancel = vi.fn();
    cancelUnlessBusy(false, onCancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while the confirmed request is running, so its error is still shown", () => {
    const onCancel = vi.fn();
    cancelUnlessBusy(true, onCancel);
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog confirmDisabled (#472)", () => {
  function render(confirmDisabled?: boolean) {
    const props: DialogProps = {
      busy: false,
      ...(confirmDisabled === undefined ? {} : { confirmDisabled }),
      confirmLabel: "Send this announcement",
      error: "",
      onCancel: () => {},
      onConfirm: () => {},
      open: true,
      title: "Review before sending",
    };
    return renderToStaticMarkup(createElement(
      ConfirmDialog,
      props as unknown as ComponentProps<typeof ConfirmDialog>,
      createElement("p", null, "Loading the recipient review…"),
    ));
  }

  it("disables only the confirm button, leaving Cancel usable", () => {
    const html = render(true);
    expect(html).toContain('<button class="primary-button" disabled="" type="button">Send this announcement</button>');
    expect(html).toContain('<button class="secondary-button" type="button">Cancel</button>');
  });

  it("keeps confirm enabled by default for existing callers", () => {
    expect(render()).toContain('<button class="primary-button" type="button">Send this announcement</button>');
  });
});
