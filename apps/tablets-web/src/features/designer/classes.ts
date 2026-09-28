import styles from './designer.module.css';

/** The hashed class name of a rule in designer.module.css ('' when absent). */
export const dcls = (name: string): string => styles[name] ?? '';
