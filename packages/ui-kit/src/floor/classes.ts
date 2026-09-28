import styles from './floor.module.css';

/** The hashed class name of a rule in floor.module.css ('' when absent). */
export const fcls = (name: string): string => styles[name] ?? '';
