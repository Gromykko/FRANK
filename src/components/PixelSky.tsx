interface PixelCloudProps {
  className: string;
  viewBox: string;
  body: string;
  shade: string;
}

function PixelCloud({ className, viewBox, body, shade }: PixelCloudProps) {
  return (
    <div className={`pixel-cloud ${className}`}>
      <svg viewBox={viewBox} focusable="false" shapeRendering="crispEdges">
        <path className="pixel-cloud-shade" d={shade} />
        <path className="pixel-cloud-body" d={body} />
      </svg>
    </div>
  );
}

// A quiet atmosphere layer, not a weather report. The shapes are intentionally
// original and decorative: real forecast meaning stays inside FRANK's panels.
export default function PixelSky() {
  return (
    <div className="pixel-sky" aria-hidden="true">
      <PixelCloud
        className="pixel-cloud-one"
        viewBox="0 0 34 14"
        shade="M2 11h5V9h4V6h3V4h5v2h4v2h6v3h3v2H2z"
        body="M2 9h5V7h4V4h3V2h5v2h4v2h6v3h3v2H2z"
      />
      <PixelCloud
        className="pixel-cloud-two"
        viewBox="0 0 29 13"
        shade="M1 10h4V8h3V5h4V3h4v2h3v2h5v3h3v2H1z"
        body="M1 8h4V6h3V3h4V1h4v2h3v2h5v3h3v2H1z"
      />
      <PixelCloud
        className="pixel-cloud-three"
        viewBox="0 0 39 15"
        shade="M2 12h6V9h5V7h3V4h5V2h5v3h3v2h5v2h3v3z"
        body="M2 10h6V7h5V5h3V2h5V0h5v3h3v2h5v2h3v3z"
      />
    </div>
  );
}
