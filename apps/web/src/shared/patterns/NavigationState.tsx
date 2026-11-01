import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

const NavigationContext = createContext<[boolean, Dispatch<SetStateAction<boolean>>]>([
  true,
  () => {},
]);
const ConversationLocation = createContext<[string, Dispatch<SetStateAction<string>>]>([
  '/chat',
  () => {},
]);

/** Keep the desktop sidebar preference when moving between chat and console routes. */
export function NavigationProvider({
  children,
  scope = 'anonymous',
}: {
  children: ReactNode;
  scope?: string;
}) {
  const state = useState(true);
  const conversation = useState('/chat');
  const [previousScope, setPreviousScope] = useState(scope);
  // Reset account-specific history without remounting the router beneath the provider.
  if (previousScope !== scope) {
    setPreviousScope(scope);
    conversation[1]('/chat');
  }
  return (
    <NavigationContext.Provider value={state}>
      <ConversationLocation.Provider value={conversation}>{children}</ConversationLocation.Provider>
    </NavigationContext.Provider>
  );
}

export function useConversationLocation() {
  return useContext(ConversationLocation);
}

export function useDesktopNavigation() {
  return useContext(NavigationContext);
}
