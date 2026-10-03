import { Monitor, Smartphone } from "lucide-react";

/**
 * Tells staff which device the form builder is made for before they pick one
 * (#743): "Computer or tablet" is pre-selected and highlighted, "Phone" is shown
 * as not suited. It is a hint, not a switch; the phone notice still replaces the
 * builder on phones (#685). Hidden on phones by CSS, where that notice already
 * says the same thing.
 */
export function BuilderDeviceHint() {
  return (
    <div aria-label="Best device for the form builder" className="builder-device-hint" role="group">
      <span className="builder-device-hint-label">Works best on</span>
      <ul>
        <li className="is-selected">
          <Monitor aria-hidden="true" size={16} />
          <strong>Computer or tablet</strong>
          <small>Recommended</small>
        </li>
        <li className="is-muted">
          <Smartphone aria-hidden="true" size={16} />
          <span>Phone</span>
          <small>Not suited</small>
        </li>
      </ul>
    </div>
  );
}
