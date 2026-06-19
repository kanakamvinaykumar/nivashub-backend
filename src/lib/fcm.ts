import "dotenv/config";
import { initializeApp, getApps, cert, applicationDefault, type App } from "firebase-admin/app";
import { getMessaging, type Message, type MulticastMessage } from "firebase-admin/messaging";

// Initialize Firebase Admin SDK
let app: App | null = null;

/**
 * Attempt to load the Firebase service account from the following sources
 * (checked in order):
 *
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON  — the full JSON string (env var)
 *   2. FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL — individual fields (env vars)
 *   3. FIREBASE_SERVICE_ACCOUNT_PATH — path to a JSON file on disk
 *   4. GOOGLE_APPLICATION_CREDENTIALS — Application Default Credentials
 */
function loadCredentials(): object | undefined {
  // 1. Full JSON string from env var
  const json = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const cred = JSON.parse(json);
      if (cred.type === "service_account") {
        console.log("[fcm] Using credentials from FIREBASE_SERVICE_ACCOUNT_JSON");
        return cred;
      }
      console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT_JSON is set but does not have type=service_account");
    } catch {
      console.warn("[fcm] FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON");
    }
  }

  // 2. Individual fields
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const projectId = process.env.FIREBASE_PROJECT_ID || "nivashub";
  if (privateKey && clientEmail) {
    console.log("[fcm] Using credentials from FIREBASE_PRIVATE_KEY + FIREBASE_CLIENT_EMAIL");
    return {
      type: "service_account",
      project_id: projectId,
      private_key: privateKey.replace(/\\n/g, "\n"),
      client_email: clientEmail,
      client_id: process.env.FIREBASE_CLIENT_ID || "",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: process.env.FIREBASE_CERT_URL || "",
    };
  }

  // 3. File path — resolve relative to CWD because .env paths are written relative to the project root
  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath) {
    try {
      const path = require("path");
      const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(resolvedPath);
    } catch (error) {
      console.error("[fcm] Failed to load Firebase service account file:", error);
    }
  }

  console.warn("[fcm] No Firebase credentials found via env vars: FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_PRIVATE_KEY+CLIENT_EMAIL, or FIREBASE_SERVICE_ACCOUNT_PATH. Push notifications will be DISABLED.");
  return undefined;
}

function getFirebaseApp(): App | null {
  if (getApps().length === 0) {
    const creds = loadCredentials();
    if (creds) {
      try {
        app = initializeApp({ credential: cert(creds) });
        return app;
      } catch (error) {
        console.error("Failed to initialize Firebase Admin with provided credentials:", error);
      }
    }

    // 4. Fall back to Application Default Credentials
    try {
      app = initializeApp({
        credential: applicationDefault(),
        projectId: process.env.FIREBASE_PROJECT_ID || "nivashub",
      });
    } catch (error) {
      console.warn(
        "Firebase Admin SDK not initialized. Push notifications disabled.\n" +
          "Configure FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_PRIVATE_KEY+CLIENT_EMAIL,\n" +
          "or FIREBASE_SERVICE_ACCOUNT_PATH in the environment.",
        error,
      );
      return null;
    }
  } else {
    app = getApps()[0];
  }

  return app;
}

export interface FcmPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  clickAction?: string;
  icon?: string;
}

/**
 * Send a push notification to a single FCM token.
 */
export async function sendPushNotification(
  token: string,
  payload: FcmPayload,
): Promise<boolean> {
  try {
    const firebaseApp = getFirebaseApp();
    if (!firebaseApp) return false;

    // Data-only message — no `notification` field.
    // This ensures Firebase `onMessage` fires in the foreground (the handler
    // in use-notifications.ts shows the browser notification), and the
    // service worker's `onBackgroundMessage` handles it in the background.
    const message: Message = {
      token,
      data: {
        title: payload.title,
        body: payload.body,
        click_action: payload.clickAction || "/",
        icon: payload.icon || "/nivashub-logo.svg",
        sound: "/notification.wav",
        tag: payload.data?.tag || "nivashub-notification",
        ...(payload.data || {}),
      },
      webpush: {
        headers: {
          "Urgency": "high",
        },
        fcmOptions: {
          link: payload.clickAction || "/",
        },
      },
    };

    await getMessaging(firebaseApp).send(message);
    return true;
  } catch (error: any) {
    if (error.code === "messaging/registration-token-not-registered") {
      console.warn("FCM token is no longer valid, should be removed:", token);
    } else {
      console.error("Failed to send push notification:", error);
    }
    return false;
  }
}

/**
 * Send a push notification to multiple FCM tokens.
 * Returns the count of successful sends.
 */
export async function sendMulticastPushNotification(
  tokens: string[],
  payload: FcmPayload,
): Promise<number> {
  if (tokens.length === 0) return 0;

  try {
    const firebaseApp = getFirebaseApp();
    if (!firebaseApp) return 0;

    const message: MulticastMessage = {
      tokens,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: {
        ...(payload.data || {}),
        click_action: payload.clickAction || "/",
        icon: payload.icon || "/nivashub-logo.svg",
      },
      webpush: {
        notification: {
          title: payload.title,
          body: payload.body,
          icon: payload.icon || "/nivashub-logo.svg",
          requireInteraction: true,
        },
        fcmOptions: {
          link: payload.clickAction || "/",
        },
      },
    };

    const messaging = getMessaging(firebaseApp);
    const response = await messaging.sendEachForMulticast(message);
    const successCount = response.successCount;

    if (response.failureCount > 0) {
      response.responses.forEach((resp: { success: boolean; error?: any }, idx: number) => {
        if (!resp.success) {
          console.warn(
            `FCM send failed for token ${idx}:`,
            resp.error?.code,
            resp.error?.message,
          );
        }
      });
    }

    return successCount;
  } catch (error) {
    console.error("Failed to send multicast push notification:", error);
    return 0;
  }
}
