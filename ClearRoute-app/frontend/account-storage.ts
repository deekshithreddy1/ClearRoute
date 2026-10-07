import { createContext, useContext, useMemo } from 'react';

export const AccountContext = createContext<string | null>(null);
// Capture identity per component so a late response cannot erase another
// account's pending operation after sign-out/sign-in.
export function useAccountStorage() {
  const account = useContext(AccountContext);
  return useMemo(() => {
    const key = (name: string) => account ? `clearroute.account.${account}.${name}` : name;
    return {
      getItem: (name: string) => localStorage.getItem(key(name)),
      setItem: (name: string, value: string) => localStorage.setItem(key(name), value),
      removeItem: (name: string) => localStorage.removeItem(key(name)),
    };
  }, [account]);
}
