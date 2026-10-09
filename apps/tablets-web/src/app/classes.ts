import styles from './app.module.css';

/** The hashed class name of a rule in app.module.css ('' when absent). */
export const cls = (name: string): string => styles[name] ?? '';
