import styles from './floor.module.css';

/** The hashed class name of a rule in the floor screens' floor.module.css ('' when absent). */
export const wcls = (name: string): string => styles[name] ?? '';
