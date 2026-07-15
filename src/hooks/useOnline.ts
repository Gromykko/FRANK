import { useEffect, useState } from 'react';

// Tracks the browser's connectivity (navigator.onLine + the online/offline
// events) so the UI can be honest when there's no network — e.g. show "Offline,
// saved forecast" instead of a green "Checked" that never actually happened.
export function useOnline(): boolean {
  const [online, setOnline] = useState<boolean>(() => {
    try {
      return navigator.onLine;
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
