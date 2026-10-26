import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { app, cloudRulesEnabled } from "../../auth/firebase";
export const firestore = cloudRulesEnabled ? getFirestore(app) : null;
if (import.meta.env.MODE === "emulator" && firestore) {
  connectFirestoreEmulator(firestore, "127.0.0.1", 18103);
}
