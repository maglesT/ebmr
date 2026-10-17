/**
 * Linear algebra (ADR 0020 point 7: ml-matrix, MIT, pinned in slice 6A-1 per D-6A-23) for the multivariate methods of
 * slice 6A-3 (PCA by singular value decomposition, eigendecomposition of covariance). Re-exported from one module so
 * the package names its numerical libraries in one place (runtime.ts records their versions with every run).
 */
export { EigenvalueDecomposition, Matrix, SingularValueDecomposition } from 'ml-matrix';
