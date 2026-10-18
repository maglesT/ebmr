declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}
declare module '*.css';
// Brand assets (src/brand): the bundler gives the URL of the file (Vite; Vitest serves the same path).
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.png' {
  const url: string;
  export default url;
}
