/**
 * Attaching a file that already lives in Google Drive.
 *
 * The gesture: the document is in Drive — a scanned contract, a deposit slip
 * saved from the bank's email — and the alternative is downloading it to this
 * machine first, finding it in the Downloads folder, and uploading it from
 * there. The file goes straight from Drive onto the receipt instead.
 *
 * Deliberately NOT a connected account. Google hands the browser a token that
 * lasts about an hour, it is used to download the bytes of the files that were
 * actually picked, and nothing is stored — no refresh token, no server-side
 * credential, nothing for Lindero to leak. The scope is `drive.file`, which
 * grants access only to the files the user chooses in the Picker and never to
 * the rest of their Drive; this is the whole reason the Picker is used rather
 * than a file list of our own, and it is also why Google does not require the
 * app to pass a security review before this can be used.
 *
 * What comes back is ordinary `File` objects, so every screen that already
 * accepts a dropped or chosen file accepts one from Drive without knowing where
 * it came from. The size and type rules stay with the caller for the same
 * reason — this module never decides what a comprobante may be, it only refuses
 * to spend a minute downloading something the caller is going to reject anyway.
 */

import { readableSize } from "./documentFiles";

/**
 * The permission asked of Google.
 *
 * `drive.file` is per-file: the Picker grants it, file by file, for what the
 * user selected. The broad alternative (`drive.readonly`, the user's whole
 * Drive) is a "restricted" scope, which means an annual third-party security
 * assessment before Google will let real users past the consent screen. This
 * feature does not need it and should never ask for it.
 */
const SCOPE = "https://www.googleapis.com/auth/drive.file";

/** Google Identity Services: the consent popup and the access token. */
const IDENTITY_SRC = "https://accounts.google.com/gsi/client";

/** The loader that `gapi.load("picker")` then pulls the Picker out of. */
const PICKER_SRC = "https://apis.google.com/js/api.js";

/*
 * `import.meta.env` is Vite's, and the test runner has no Vite — reading it
 * unguarded there is a TypeError at import time, which would take out any test
 * that touches this file rather than just the parts that need a browser.
 */
const environment: Record<string, string | undefined> =
  typeof import.meta.env === "undefined" ? {} : import.meta.env;

const CLIENT_ID = (environment.VITE_GOOGLE_CLIENT_ID ?? "").trim();
const API_KEY = (environment.VITE_GOOGLE_API_KEY ?? "").trim();
const APP_ID = (environment.VITE_GOOGLE_APP_ID ?? "").trim();

/**
 * Whether this installation has been given Google credentials at all.
 *
 * False is a perfectly ordinary state: a deploy that never set the variables,
 * which is every deploy until somebody creates a Google Cloud project for it.
 * Screens check this and leave the button out entirely rather than offering
 * one that opens a Google error page.
 */
export function googleDriveConfigured(): boolean {
  return CLIENT_ID !== "" && API_KEY !== "";
}

/** One file as the Picker describes it. Only the fields actually read. */
export interface PickedDoc {
  id: string;
  name: string;
  mimeType: string;
  /** Google sends this as a string often enough to accept both. */
  sizeBytes?: number | string;
}

export interface DrivePickRequest {
  /** The content types the caller can actually store, e.g. its own allow-list. */
  mimeTypes: string[];
  /** The ceiling the caller enforces anyway, in bytes. */
  maxBytes: number;
  /**
   * "Descargando factura.pdf…". The caller owns the rest of the busy line — it
   * sets its own before calling and clears it after — so there is no gap
   * between the last download and the caller's "Subiendo…" for the line on
   * screen to blink through.
   */
  onProgress?: (message: string) => void;
}

export interface DrivePickResult {
  /** Downloaded and ready to hand to the same code a dropped file goes through. */
  files: File[];
  /** What was refused or failed, in the words the screen should show. */
  rejections: string[];
}

/**
 * Which of these are worth downloading, and what to say about the rest.
 *
 * Pure, and separated from the Picker for the reason the rest of this app
 * separates its rules from its plumbing: this is the part with decisions in it.
 * The size check matters before the download rather than after — the caller
 * refuses an oversized file in a millisecond once it is here, but getting it
 * here is a minute of somebody's phone data for a file that was never going to
 * be accepted.
 *
 * Native Google formats get their own message. A Google Doc has no bytes to
 * download at all — the Drive API answers "use export instead" — and a picker
 * filtered to PDFs can still surface one through search. "No se pudo descargar"
 * would send somebody looking for a network fault that is not there.
 */
export function triagePickedDocs(
  docs: PickedDoc[],
  limits: { mimeTypes: string[]; maxBytes: number },
): { wanted: PickedDoc[]; rejections: string[] } {
  const wanted: PickedDoc[] = [];
  const rejections: string[] = [];
  const ceiling = `${Math.round(limits.maxBytes / 1024 / 1024)} MB`;

  for (const doc of docs) {
    if (doc.mimeType.startsWith("application/vnd.google-apps.")) {
      rejections.push(
        `“${doc.name}” is a Google file. Download it as a PDF and attach it again.`,
      );
      continue;
    }

    if (!limits.mimeTypes.includes(doc.mimeType)) {
      rejections.push(`“${doc.name}” is not an image or PDF.`);
      continue;
    }

    const size = typeof doc.sizeBytes === "string" ? Number(doc.sizeBytes) : doc.sizeBytes;

    // Unknown size is let through rather than refused: the caller weighs the
    // real file once it is downloaded, and that check is the one that counts.
    if (typeof size === "number" && Number.isFinite(size) && size > limits.maxBytes) {
      rejections.push(`“${doc.name}” is ${readableSize(size)}; the maximum is ${ceiling}.`);
      continue;
    }

    wanted.push(doc);
  }

  return { wanted, rejections };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
}

interface TokenClient {
  requestAccessToken: () => void;
}

interface DocsView {
  setIncludeFolders: (on: boolean) => DocsView;
  setMimeTypes: (types: string) => DocsView;
  setSelectFolderEnabled: (on: boolean) => DocsView;
}

interface BuiltPicker {
  setVisible: (visible: boolean) => void;
  dispose: () => void;
}

interface PickerBuilder {
  addView: (view: DocsView) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (appId: string) => PickerBuilder;
  setLocale: (locale: string) => PickerBuilder;
  setTitle: (title: string) => PickerBuilder;
  enableFeature: (feature: string) => PickerBuilder;
  setCallback: (callback: (data: Record<string, unknown>) => void) => PickerBuilder;
  build: () => BuiltPicker;
}

interface PickerNamespace {
  DocsView: new (viewId?: string) => DocsView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: string };
  Feature: { MULTISELECT_ENABLED: string };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: { type?: string }) => void;
          }) => TokenClient;
        };
      };
      picker?: PickerNamespace;
    };
    gapi?: {
      load: (api: string, config: { callback: () => void; onerror?: () => void }) => void;
    };
  }
}

const scripts = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const already = scripts.get(src);

  if (already) {
    return already;
  }

  const loading = new Promise<void>((resolve, reject) => {
    const element = document.createElement("script");

    element.src = src;
    element.async = true;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error("Could not load Google Drive."));

    document.head.appendChild(element);
  });

  // A failed load is forgotten so the next click tries again. Cached, the
  // feature would stay broken for the life of the tab after one bad moment of
  // connectivity.
  scripts.set(
    src,
    loading.catch((caught: unknown) => {
      scripts.delete(src);
      throw caught;
    }),
  );

  return scripts.get(src)!;
}

let pickerReady: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  pickerReady ??= loadScript(PICKER_SRC).then(
    () =>
      new Promise<void>((resolve, reject) => {
        const gapi = window.gapi;

        if (!gapi) {
          reject(new Error("Could not load Google Drive."));
          return;
        }

        gapi.load("picker", {
          callback: () => resolve(),
          onerror: () => reject(new Error("Could not load the Google Drive picker.")),
        });
      }),
  );

  return pickerReady.catch((caught: unknown) => {
    pickerReady = null;
    throw caught;
  });
}

/**
 * Fetch Google's scripts ahead of the click that needs them.
 *
 * The popup that asks for consent has to open during the click that asked for
 * it — browsers grant a few seconds of "the user just did something" and refuse
 * to open a popup outside it, which is indistinguishable, on screen, from the
 * button doing nothing. Loading two scripts off Google's CDN can eat that
 * window on a slow connection, so screens that offer the button call this when
 * they mount and the click finds everything already in place.
 *
 * Failure is ignored on purpose: this is a head start, not a requirement, and
 * the click path reports its own problems.
 */
export function preloadGoogleDrive(): void {
  if (!googleDriveConfigured()) {
    return;
  }

  void loadScript(IDENTITY_SRC).catch(() => {});
  void loadPicker().catch(() => {});
}

let tokenClient: TokenClient | null = null;
let pendingToken: ((response: TokenResponse | null) => void) | null = null;
let heldToken: { value: string; expiresAt: number } | null = null;

/**
 * An access token for the files this person is about to pick.
 *
 * Held until it expires so that attaching a second file does not put a second
 * consent popup in the way. Resolves to null when the popup is closed without
 * a decision, which is a cancellation and not an error — somebody changed their
 * mind, and there is nothing to tell them about it.
 */
async function requestAccessToken(): Promise<string | null> {
  if (heldToken && heldToken.expiresAt > Date.now()) {
    return heldToken.value;
  }

  await loadScript(IDENTITY_SRC);

  const oauth2 = window.google?.accounts?.oauth2;

  if (!oauth2) {
    throw new Error("Could not load Google Drive.");
  }

  tokenClient ??= oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (response) => {
      const settle = pendingToken;
      pendingToken = null;
      settle?.(response);
    },
    // Without this, a closed popup settles nothing and the button stays
    // spinning until the tab is reloaded.
    error_callback: () => {
      const settle = pendingToken;
      pendingToken = null;
      settle?.(null);
    },
  });

  const response = await new Promise<TokenResponse | null>((resolve) => {
    pendingToken = resolve;
    tokenClient!.requestAccessToken();
  });

  if (!response || !response.access_token) {
    return null;
  }

  // A minute short of Google's own expiry, so a token cannot go stale between
  // the check above and the request that uses it.
  const seconds = typeof response.expires_in === "number" ? response.expires_in : 3600;
  heldToken = { value: response.access_token, expiresAt: Date.now() + (seconds - 60) * 1000 };

  return heldToken.value;
}

function showPicker(token: string, mimeTypes: string[]): Promise<PickedDoc[]> {
  return new Promise((resolve, reject) => {
    const picker = window.google?.picker;

    if (!picker) {
      reject(new Error("Could not load the Google Drive picker."));
      return;
    }

    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false)
      .setMimeTypes(mimeTypes.join(","));

    const builder = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setLocale("en")
      .setTitle("Choose a proof file")
      .enableFeature(picker.Feature.MULTISELECT_ENABLED);

    /*
     * The Cloud project number. With `drive.file` this is what ties the grant
     * the Picker makes to the app that is about to download the file — without
     * it the file is picked successfully and the download then answers 404,
     * which reads as a missing file rather than a missing permission.
     */
    if (APP_ID !== "") {
      builder.setAppId(APP_ID);
    }

    let built: BuiltPicker | null = null;

    const finish = (docs: PickedDoc[]) => {
      // Leaves no Google iframe or grey backdrop behind. Without it the second
      // open stacks on the first and the page cannot be clicked afterwards.
      built?.dispose();
      resolve(docs);
    };

    built = builder
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];

        if (action === picker.Action.CANCEL) {
          finish([]);
          return;
        }

        if (action !== picker.Action.PICKED) {
          // LOADED and anything Google adds later.
          return;
        }

        const documents = data[picker.Response.DOCUMENTS];

        finish(Array.isArray(documents) ? (documents as PickedDoc[]) : []);
      })
      .build();

    built.setVisible(true);
  });
}

async function downloadDriveFile(doc: PickedDoc, token: string): Promise<File> {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    throw new Error(`Google Drive returned ${response.status}`);
  }

  const blob = await response.blob();

  return new File([blob], doc.name, { type: doc.mimeType || blob.type });
}

/**
 * Open Google's file picker and bring back what was chosen, as files.
 *
 * MUST be called from a click handler: the consent popup opens inside this
 * call, and a browser only allows that while a user gesture is still fresh.
 *
 * Downloads one at a time, like the uploads on the other side of this do, so
 * one file that fails halfway leaves the others alone and says which one it
 * was. An empty result is the ordinary outcome of changing your mind — at the
 * consent screen or in the Picker — and carries no rejection with it.
 */
export async function openGoogleDrivePicker(request: DrivePickRequest): Promise<DrivePickResult> {
  if (!googleDriveConfigured()) {
    throw new Error("Google Drive is not configured for this installation.");
  }

  await loadPicker();

  const token = await requestAccessToken();

  if (token === null) {
    return { files: [], rejections: [] };
  }

  const picked = await showPicker(token, request.mimeTypes);
  const { wanted, rejections } = triagePickedDocs(picked, request);
  const files: File[] = [];

  for (const doc of wanted) {
    request.onProgress?.(`Downloading ${doc.name}…`);

    try {
      files.push(await downloadDriveFile(doc, token));
    } catch {
      rejections.push(`Could not retrieve “${doc.name}” from Google Drive.`);
    }
  }

  return { files, rejections };
}
