/** Framer owns transform/layout motion; CSS timing tokens remain separate. */
export const interfaceSpring = {
  type: 'spring' as const,
  stiffness: 430,
  damping: 38,
  mass: 0.72,
};
