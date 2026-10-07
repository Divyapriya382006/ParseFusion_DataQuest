import React, { createContext, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAppConfig, CONFIG_ENDPOINT } from "../api/config";
import { NotConnectedError } from "../api/errors";
import type { AppConfig } from "../types/api";

interface ConfigContextType {
  config: AppConfig | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isNotConnected: boolean;
  notConnectedEndpoint?: string;
  refetch: () => void;
}

const ConfigContext = createContext<ConfigContextType>({
  config: undefined,
  isLoading: true,
  isError: false,
  error: null,
  isNotConnected: false,
  refetch: () => {},
});

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data: config, isLoading, isError, error, refetch } = useQuery<AppConfig>({
    queryKey: ["appConfig"],
    queryFn: ({ signal }) => fetchAppConfig(signal),
    retry: 1,
    staleTime: 60 * 1000,
  });

  const isNotConnected =
    error instanceof NotConnectedError ||
    (isError && !config);

  const notConnectedEndpoint =
    error instanceof NotConnectedError ? error.endpoint : isNotConnected ? CONFIG_ENDPOINT : undefined;

  return (
    <ConfigContext.Provider
      value={{
        config,
        isLoading,
        isError,
        error,
        isNotConnected,
        notConnectedEndpoint,
        refetch,
      }}
    >
      {children}
    </ConfigContext.Provider>
  );
};

export function useConfig(): ConfigContextType {
  return useContext(ConfigContext);
}
