import React, { createContext, useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchCurrentUser, switchDemoRole as switchRoleRequest, AUTH_ME_ENDPOINT } from "../api/auth";
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
  switchDemoRole: (role: "admin" | "viewer") => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: undefined,
  isLoading: true,
  isError: false,
  error: null,
  isNotConnected: false,
  hasCapability: () => false,
  refetch: () => {},
  switchDemoRole: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const queryClient = useQueryClient();
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

  const switchDemoRole = async (role: "admin" | "viewer") => {
    const updatedUser = await switchRoleRequest(role);
    await queryClient.cancelQueries();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "currentUser" });
    queryClient.setQueryData(["currentUser"], updatedUser);
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "currentUser" });
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
        switchDemoRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextType {
  return useContext(AuthContext);
}
