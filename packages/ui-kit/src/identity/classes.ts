import styles from './identity.module.css';

/** The hashed class name of a rule in identity.module.css ('' when absent). */
export const icls = (name: string): string => styles[name] ?? '';
