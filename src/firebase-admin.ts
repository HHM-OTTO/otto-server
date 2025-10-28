import { initializeApp, getApps, getApp, cert, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Initialize Firebase Admin SDK
let app: App;
try {
  // Check if an app is already initialized
  if (getApps().length === 0) {
    // Initialize with service account if available, otherwise use project ID
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    
    if (serviceAccount) {
      // Production: Use service account key
      app = initializeApp({
        credential: cert(JSON.parse(serviceAccount)),
        projectId
      });
    } else if (projectId) {
      // Development: Use project ID only
      app = initializeApp({
        projectId
      });
    } else {
      // Demo mode: Create a minimal app
      app = initializeApp({
        projectId: "demo-project"
      });
    }
  } else {
    app = getApp();
  }
} catch (error) {
  console.error('Firebase Admin initialization error:', error);
  // Create a minimal demo app as fallback
  app = initializeApp({
    projectId: "demo-project"
  });
}

export const adminAuth = getAuth(app);

// Utility function to verify Firebase token
export async function verifyFirebaseToken(token: string): Promise<{ uid: string; email?: string; name?: string } | null> {
  try {
    // Only return demo user for actual demo tokens
    if (token === 'demo-token') {
      return { uid: 'demo-uid', email: 'demo@example.com', name: 'Demo User' };
    }

    // Try to verify the token as a real Firebase token
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PROJECT_ID !== 'demo-project') {
      const decodedToken = await adminAuth.verifyIdToken(token);
      return {
        uid: decodedToken.uid,
        email: decodedToken.email,
        name: decodedToken.name || decodedToken.email?.split('@')[0]
      };
    } else {
      // If Firebase Admin SDK is not configured, decode the JWT manually
      // Firebase ID tokens are JWTs, so we can at least extract the claims
      try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
        
        const claims = JSON.parse(jsonPayload);
        
        // Check if this is a valid Firebase token structure
        if (claims.iss && claims.iss.includes('securetoken.google.com')) {
          return {
            uid: claims.user_id || claims.sub,
            email: claims.email,
            name: claims.name || claims.email?.split('@')[0]
          };
        }
      } catch (decodeError) {
        console.error('Failed to decode token:', decodeError);
      }
      
      // Token is not a demo token and couldn't be decoded as Firebase token
      return null;
    }
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}