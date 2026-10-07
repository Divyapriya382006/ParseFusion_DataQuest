import React, { createContext, useContext, useState } from "react";
import type { EvidenceReference } from "../types/canonical";

interface EvidenceContextType {
  activeEvidence: EvidenceReference | null;
  secondaryEvidence: EvidenceReference | null;
  isModalOpen: boolean;
  openEvidence: (primary: EvidenceReference, secondary?: EvidenceReference) => void;
  closeEvidence: () => void;
}

const EvidenceContext = createContext<EvidenceContextType>({
  activeEvidence: null,
  secondaryEvidence: null,
  isModalOpen: false,
  openEvidence: () => {},
  closeEvidence: () => {},
});

export const EvidenceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeEvidence, setActiveEvidence] = useState<EvidenceReference | null>(null);
  const [secondaryEvidence, setSecondaryEvidence] = useState<EvidenceReference | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const openEvidence = (primary: EvidenceReference, secondary?: EvidenceReference) => {
    setActiveEvidence(primary);
    setSecondaryEvidence(secondary || null);
    setIsModalOpen(true);
  };

  const closeEvidence = () => {
    setIsModalOpen(false);
  };

  return (
    <EvidenceContext.Provider
      value={{
        activeEvidence,
        secondaryEvidence,
        isModalOpen,
        openEvidence,
        closeEvidence,
      }}
    >
      {children}
    </EvidenceContext.Provider>
  );
};

export function useEvidence(): EvidenceContextType {
  return useContext(EvidenceContext);
}
