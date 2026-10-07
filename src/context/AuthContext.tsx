import React, { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchCurrentUser, AUTH_ME_ENDPOINT } from "../api/auth";
import { NotConnectedError } from "../api/errors";
import { hasCapability as checkCapability } from "../config/capabilityKeys";
import type { UserProfile } from "../types/api";

interface AuthContextType {
  user: UserProfile | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isNotConnected: boolean;
  notConnectedEndpoint?: string;
  hasCapability: (requiredKey: string) => boolean;
  refetch: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: undefined,
  isLoading: true,
  isError: false,
  error: null,
  isNotConnected: false,
  hasCapability: () => false,
  refetch: () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data: user, isLoading, isError, error, refetch } = useQuery<UserProfile>({
    queryKey: ["currentUser"],
    queryFn: ({ signal }) => fetchCurrentUser(signal),
    retry: 1,
    staleTime: 60 * 1000,
  });

  const isNotConnected =
    error instanceof NotConnectedError ||
    (isError && !user);

  const notConnectedEndpoint =
    error instanceof NotConnectedError ? error.endpoint : isNotConnected ? AUTH_ME_ENDPOINT : undefined;

  const hasCapability = (requiredKey: string): boolean => {
    return checkCapability(user?.capabilities, requiredKey);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isError,
        error,
        isNotConnected,
        notConnectedEndpoint,
        hasCapability,
        refetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  return useContext(AuthContext);
}
