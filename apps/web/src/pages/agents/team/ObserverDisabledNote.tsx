/**
 * Plain-language pointer for disabled Observer. Does not replace Edit.
 */
import { Link } from "react-router-dom";

export function ObserverDisabledNote() {
  return (
    <p className="team-observer-note">
      Disabled globally. Enable under{" "}
      <Link to="/capabilities">Capabilities</Link>
      {" / "}
      <Link to="/system?section=global-availability">Global Availability</Link>
      .
    </p>
  );
}
