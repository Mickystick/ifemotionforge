import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { Dialog } from "./Dialog";
import { IconChevronDown, IconZoomIn, IconZoomOut } from "./Icons";
import { documentKind, formatBadge, isFragileImage, readableSize } from "../lib/documentFiles";

/** How far a click of the zoom buttons, or one wheel tick, moves the scale. */
const ZOOM_STEP = 0.5;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/**
 * One document the viewer can show.
 *
 * `url` is deliberately the only thing it knows about WHERE the bytes are, so
 * the same component serves a file already stored on the server (an
 * `/api/attachments/:id/file` or `/api/contract-documents/:id/file` URL) and
 * one the user has only just picked and not uploaded yet (a `blob:` URL for
 * the File in hand). Checking a file before it is saved and checking one saved
 * months ago are the same act, and they should not be two different screens.
 */
export interface ViewerFile {
  id: string;
  name: string;
  contentType: string;
  url: string;
  /** The lot this is evidence for, when it is filed against one. */
  caption?: string | null;
  sizeBytes?: number;
}

interface DocumentViewerProps {
  files: ViewerFile[];
  /** Which one to open on. Falls back to the first if it is no longer here. */
  startId: string;
  onClose: () => void;
  /**
   * Offered only where the caller can actually act on it. Absent rather than
   * disabled: a delete button that cannot delete is worse than none.
   *
   * The caller is expected to CONFIRM before destroying anything stored — this
   * hands over the intent, not the deed. The dropzone is the one exception and
   * removes immediately, because nothing has been uploaded there yet and
   * picking the file again is the whole cost of being wrong.
   */
  onRemove?: (file: ViewerFile) => void;
}

/**
 * Look at a document, without it landing in Downloads.
 *
 * One viewer for every stored file the app holds — the comprobante behind a
 * payment, the signed contract for a lot, and the receipt image on its way to
 * WhatsApp. They are the same act (look at this, full size, without saving it
 * anywhere), so they are the same component, and a file behaves identically
 * wherever it is opened from.
 *
 * This is the whole reason the serving endpoints stopped saying
 * `Content-Disposition: attachment`. A stored file used to be readable only by
 * downloading it, which meant every "is this the right one?" left a copy on
 * whatever machine asked — usually the shared one at the front desk,
 * permanently, in a folder nobody ever empties. That was bad for a customer's
 * bank slip and worse for a signed contract. The files are kept on the server
 * precisely so they stop being scattered across devices; a viewer that
 * downloads them defeats the point of storing them centrally at all.
 *
 * So: the bytes are streamed from Lindero, drawn in place, and forgotten when
 * this closes. Nothing is written to disk, and there is deliberately no
 * "descargar" button anywhere in it.
 */
export function DocumentViewer({ files, startId, onClose, onRemove }: DocumentViewerProps) {
  const [index, setIndex] = useState(() => {
    const found = files.findIndex((file) => file.id === startId);
    return found === -1 ? 0 : found;
  });

  /*
   * A failed render is per-file, not per-viewer.
   *
   * Held as a set of ids rather than a boolean so that paging from a HEIC that
   * would not draw onto a JPG that will does not carry the error message
   * across with it — and so that paging back shows the message again without
   * re-attempting a load that has already been shown not to work.
   */
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());

  // The list shrinks when a file is removed from inside the viewer. Landing on
  // the one that took its place is what somebody deleting several in a row
  // expects; running off the end closes instead of showing a blank frame.
  const safeIndex = Math.min(index, Math.max(0, files.length - 1));
  const current = files[safeIndex];
  const kind = current ? documentKind(current.contentType) : undefined;

  /*
   * How far into the image the viewer is zoomed, and by how much its centre
   * has been dragged off from the middle of the stage. Both reset the moment
   * the file on screen changes — a receipt zoomed in to check a total should
   * not leave the NEXT one, a photo of a bank slip, already blown up past
   * where its own text is legible.
   */
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (files.length === 0) {
      onClose();
    }
  }, [files.length, onClose]);

  useEffect(() => {
    // Arrow keys page through. Escape is the Dialog's, which also owns the
    // stack — this can be opened from ON TOP of the new-receipt form, and only
    // the topmost surface may answer a keypress.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        setIndex((at) => (at === 0 ? files.length - 1 : at - 1));
      } else if (event.key === "ArrowRight") {
        setIndex((at) => (at + 1) % files.length);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [files.length]);

  useEffect(() => {
    setZoom(MIN_ZOOM);
    setPan({ x: 0, y: 0 });
  }, [current?.id]);

  /*
   * How far the image may be dragged before its edge would leave the stage
   * empty on the other side — measured off the boxes actually on screen
   * rather than carried in state, since `getBoundingClientRect` already
   * reflects the scale just applied. Locked to (0, 0) at MIN_ZOOM, which is
   * what keeps a reset snapping the receipt back to centred.
   */
  const clampPan = (x: number, y: number) => {
    const stage = stageRef.current;
    const image = imageRef.current;
    if (!stage || !image) {
      return { x: 0, y: 0 };
    }

    const stageBox = stage.getBoundingClientRect();
    const imageBox = image.getBoundingClientRect();
    const maxX = Math.max(0, (imageBox.width - stageBox.width) / 2);
    const maxY = Math.max(0, (imageBox.height - stageBox.height) / 2);

    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  };

  /** Every way of changing the zoom funnels through here, so panning always
      ends up back inside bounds and a return to MIN_ZOOM always re-centres. */
  const applyZoom = (next: number) => {
    const clamped = Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) * 100) / 100;
    setZoom(clamped);
    setPan((prevPan) => (clamped === MIN_ZOOM ? { x: 0, y: 0 } : clampPan(prevPan.x, prevPan.y)));
  };

  const zoomIn = () => applyZoom(zoom + ZOOM_STEP);
  const zoomOut = () => applyZoom(zoom - ZOOM_STEP);
  const resetZoom = () => applyZoom(MIN_ZOOM);
  const toggleZoom = () => applyZoom(zoom > MIN_ZOOM ? MIN_ZOOM : 2);

  useEffect(() => {
    // A magnifying glass is the whole point of this component, so the wheel
    // zooms rather than doing nothing — but it has to bypass React's `onWheel`,
    // which Chrome treats as passive by default and would silently ignore the
    // `preventDefault()` a zoom needs to stop the page moving under it.
    const stage = stageRef.current;
    if (!stage || kind !== "image") {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyZoom(zoom + (event.deltaY > 0 ? -ZOOM_STEP / 2 : ZOOM_STEP / 2));
    };

    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, current?.id, zoom]);

  useEffect(() => {
    if (kind !== "image") {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomIn();
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomOut();
      } else if (event.key === "0") {
        resetZoom();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, zoom]);

  /*
   * Dragging to look at a corner of a zoomed-in receipt. Only starts past
   * MIN_ZOOM — at 1:1 the whole document already fits the stage, and a drag
   * that could not move anything is a cursor that lies about what the mouse
   * does here.
   */
  const onImageMouseDown = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (zoom <= MIN_ZOOM) {
      return;
    }
    event.preventDefault();
    setDragging(true);
    const start = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };

    const onMouseMove = (moveEvent: MouseEvent) => {
      setPan(
        clampPan(start.panX + (moveEvent.clientX - start.x), start.panY + (moveEvent.clientY - start.y)),
      );
    };

    const onMouseUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  if (!current) {
    return null;
  }

  const isBroken = broken.has(current.id);
  const hasMany = files.length > 1;

  const step = (by: number) =>
    setIndex((at) => (at + by + files.length) % files.length);

  return (
    <Dialog ariaLabel={`Documento ${current.name}`} size="viewer" onClose={onClose}>
      <div className="viewer">
        <header className="viewer-head">
          <div className="viewer-title">
            <p className="viewer-name">{current.name}</p>
            <p className="viewer-sub">
              {current.caption && <span className="viewer-lot">{current.caption}</span>}
              {current.sizeBytes !== undefined && <span>{readableSize(current.sizeBytes)}</span>}
              {hasMany && (
                <span>
                  {safeIndex + 1} de {files.length}
                </span>
              )}
            </p>
          </div>

          {/*
            Close, and nothing else.

            "Quitar" used to sit right here, a few pixels from the ×. Two
            controls that far apart in consequence must not be that close
            together on screen — the hand goes to the top-right corner to
            dismiss something, and the thing it found there could destroy a
            signed contract. It now lives at the foot of the viewer, diagonally
            opposite this button.
          */}
          <button type="button" className="viewer-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="viewer-stage" ref={stageRef}>
          {hasMany && (
            <button
              type="button"
              className="viewer-step is-prev"
              onClick={() => step(-1)}
              aria-label="Previous proof file"
            >
              <IconChevronDown />
            </button>
          )}

          {kind === "image" && !isBroken && (
            /*
             * Keyed on the id so React swaps the element rather than reusing it
             * with a new `src`. Without the key, paging from a large photo to a
             * small one leaves the previous picture on screen while the next
             * decodes, which reads as the arrow having done nothing.
             *
             * The transform is translate-then-scale, in that order: CSS applies
             * the rightmost function first, so the image scales about its own
             * centre BEFORE the pan shifts it — which is what keeps `pan` in
             * plain screen pixels instead of pixels-divided-by-zoom.
             */
            <img
              key={current.id}
              ref={imageRef}
              className={`viewer-image${isDragging ? " is-panning" : ""}`}
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transition: isDragging ? "none" : "transform 0.12s ease",
                cursor: zoom > MIN_ZOOM ? (isDragging ? "grabbing" : "grab") : "zoom-in",
              }}
              src={current.url}
              alt={current.name}
              draggable={false}
              onError={() => setBroken((was) => new Set(was).add(current.id))}
              onMouseDown={onImageMouseDown}
              onDoubleClick={toggleZoom}
              title={zoom > MIN_ZOOM ? "Drag to move around the receipt" : "Double-click to zoom in"}
            />
          )}

          {kind === "image" && !isBroken && (
            <div className="viewer-zoom">
              <button
                type="button"
                onClick={zoomOut}
                disabled={zoom <= MIN_ZOOM}
                aria-label="Zoom out"
              >
                <IconZoomOut />
              </button>
              <button
                type="button"
                className="viewer-zoom-value"
                onClick={resetZoom}
                disabled={zoom === MIN_ZOOM}
                aria-label="Reset zoom"
                title="Reset zoom"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                onClick={zoomIn}
                disabled={zoom >= MAX_ZOOM}
                aria-label="Zoom in"
              >
                <IconZoomIn />
              </button>
            </div>
          )}

          {kind === "pdf" && (
            /*
             * The browser's own PDF viewer, in a frame. The response carries
             * `Content-Security-Policy: sandbox allow-scripts`, so the document
             * inside renders in an opaque origin and cannot reach this page,
             * the session cookie or any endpoint — see routes/receipts.ts.
             *
             * A blob: URL works here as well, which is what makes a PDF
             * checkable BEFORE it is uploaded and not only after.
             */
            <iframe key={current.id} className="viewer-frame" src={current.url} title={current.name} />
          )}

          {(kind === "opaque" || isBroken) && (
            <div className="viewer-unavailable">
              <span className="doc-thumb doc-thumb-badge">{formatBadge(current.contentType)}</span>
              <p>
                {isFragileImage(current.contentType)
                  ? "This browser can't display HEIC photos from iPhone. The file is safely stored; open it in Safari or ask for a JPG copy."
                  : "This file is safely stored, but your browser can't display it here."}
              </p>
            </div>
          )}

          {hasMany && (
            <button
              type="button"
              className="viewer-step is-next"
              onClick={() => step(1)}
              aria-label="Next payment proof"
            >
              <IconChevronDown />
            </button>
          )}
        </div>

        {hasMany && (
          <div className="viewer-strip">
            {files.map((file, at) => (
              <button
                key={file.id}
                type="button"
                className={`viewer-strip-item${at === safeIndex ? " is-current" : ""}`}
                onClick={() => setIndex(at)}
                aria-label={file.name}
                aria-current={at === safeIndex}
              >
                <DocumentThumb file={file} />
              </button>
            ))}
          </div>
        )}

        {onRemove && (
          /*
           * Bottom-left, which is the furthest point in this box from the close
           * button in the top-right. Deliberately not a bare icon and not
           * beside anything else that gets pressed routinely: it is the only
           * control down here, it says what it removes, and pressing it opens a
           * confirmation rather than doing the thing.
           */
          <div className="viewer-foot">
            <button
              type="button"
              className="link-btn is-danger"
              onClick={() => onRemove(current)}
            >
              Remove this file
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The small square that stands for a stored file.
 *
 * The picture itself where the browser can draw it, and an honest label where
 * it cannot — a PDF or an iPhone HEIC gets its format written on a tile rather
 * than a broken-image icon. A scanned contract is almost always the PDF case,
 * so that tile is not an edge case here: it is the normal appearance of the
 * feature it was written for.
 *
 * Used in four places (the transactions row, the receipt panel, the dropzone,
 * the contract panel), which is why it is one component: a thumbnail that looks
 * different depending on where it appears reads as a different kind of thing.
 *
 * `loading="lazy"` is doing real work on the transactions list. Every row can
 * carry one of these, the bytes are full-size phone photographs, and a hundred
 * rows of eager <img> would be a hundred megabytes fetched to draw a screen
 * showing twelve of them.
 */
export function DocumentThumb({ file }: { file: ViewerFile }) {
  const [isBroken, setBroken] = useState(false);
  const kind = documentKind(file.contentType);

  if (kind !== "image" || isBroken) {
    return <span className="doc-thumb doc-thumb-badge">{formatBadge(file.contentType)}</span>;
  }

  return (
    <img
      className="doc-thumb"
      src={file.url}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
    />
  );
}
