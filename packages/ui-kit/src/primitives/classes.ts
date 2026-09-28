import styles from './ui.module.css';

/** The hashed class name of a rule in ui.module.css ('' when absent). */
export const cls = (name: string): string => styles[name] ?? '';
