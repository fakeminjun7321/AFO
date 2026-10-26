export function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {diagonal ? (
        <path d="M6 18 18 6M6 6h12v12" />
      ) : (
        <path d="M4 12h15m-6-6 6 6-6 6" />
      )}
    </svg>
  );
}

export type FileKind =
  "pdf" | "image" | "slides" | "video" | "text" | "archive";
export function FileIcon({ kind }: { kind: FileKind }) {
  return (
    <svg
      className={`file-icon file-icon--${kind}`}
      width="30"
      height="34"
      viewBox="0 0 30 34"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 1h14l7 7v23a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z"
        fill="currentColor"
      />
      <path d="M19 1v6a1 1 0 0 0 1 1h6" fill="#ffffff" opacity=".3" />
      <g
        stroke="#141414"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {kind === "pdf" && (
          <path d="M9 25c5-8 6-13 4-13s-1 10 7 12c2 1 1-3-4-3S7 27 9 25Z" />
        )}
        {kind === "image" && (
          <>
            <circle cx="10" cy="13" r="1.5" fill="#141414" />
            <path d="m7 26 6-8 4 5 3-4 3 7Z" fill="#141414" />
          </>
        )}
        {kind === "slides" && <path d="M11 26V14h4a3.5 3.5 0 0 1 0 7h-4" />}
        {kind === "video" && (
          <path d="m11 14 9 6-9 6Z" fill="#141414" stroke="none" />
        )}
        {kind === "text" && <path d="M9 15h11M9 20h11M9 25h7" />}
        {kind === "archive" && (
          <path d="M14 9h3m-3 4h3m-3 4h3m-3 4h3m-3 4h3v4h-3z" />
        )}
      </g>
    </svg>
  );
}
