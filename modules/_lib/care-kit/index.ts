// Care connector kit: the contract between the `care` module and channel modules (zalo, gmail, …).
// Shared code, not a module (modules/_lib is skipped by the loader). Copied from the owner's
// src/customer-care/{domain/{types,errors,checkpoint,validation},connectors/contract}.ts.
export * from './types.js';
export * from './errors.js';
export * from './checkpoint.js';
export * from './validation.js';
export * from './contract.js';
