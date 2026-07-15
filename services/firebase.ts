import { getApp, getApps, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { getAuth, GoogleAuthProvider, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig: FirebaseOptions = {
  // Firebase web configuration identifies the public app; authorization still
  // comes from Authentication and Firestore Security Rules. Environment values
  // can override these defaults for preview or staging projects.
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyCQenus-MpVsnfsiGMIKVr66Ag7TikasEk',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'orin-ai-502503.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'orin-ai-502503',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'orin-ai-502503.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '277254919824',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:277254919824:web:4c508c9e342ef4d7be6a15',
};

export const firebaseConfigured = Boolean(
  firebaseConfig.apiKey
  && firebaseConfig.authDomain
  && firebaseConfig.projectId
  && firebaseConfig.appId,
);

export const firebaseApp: FirebaseApp | null = firebaseConfigured
  ? (getApps().length ? getApp() : initializeApp(firebaseConfig))
  : null;

export const auth: Auth | null = firebaseApp ? getAuth(firebaseApp) : null;
export const db: Firestore | null = firebaseApp ? getFirestore(firebaseApp) : null;

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });
