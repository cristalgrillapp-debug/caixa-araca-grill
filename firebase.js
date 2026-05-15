import { initializeApp } from "firebase/app"
import { getFirestore } from "firebase/firestore"
import { getStorage } from "firebase/storage"

const firebaseConfig = {
  apiKey: "AIzaSyAx9W-A2l2qqHZthQxG48yuhqFBwLqAo5U",
  authDomain: "caixagrill-7f947.firebaseapp.com",
  projectId: "caixagrill-7f947",
  storageBucket: "caixagrill-7f947.firebasestorage.app",
  messagingSenderId: "601068891689",
  appId: "1:601068891689:web:2e9b038655c588caacb638"
}

const app = initializeApp(firebaseConfig)

export const db      = getFirestore(app)
export const storage = getStorage(app)
