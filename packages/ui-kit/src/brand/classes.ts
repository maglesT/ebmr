import styles from './brand.module.css';

/** The hashed class name of a rule in brand.module.css ('' when absent). */
export const bcls = (name: string): string => styles[name] ?? '';
