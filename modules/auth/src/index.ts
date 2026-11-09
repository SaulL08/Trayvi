export * from './contracts/index';
export * from './infrastructure/shared/index';

// Stream entry points (SPEC-001 design §4). Each stream replaces its own `export {};` file.
export * from './domain/contact/index';
export * from './domain/challenge/index';
export * from './domain/rate-limit/index';
export * from './domain/delivery/index';
export * from './domain/callbacks/index';
export * from './application/contact/index';
export * from './application/challenge/index';
export * from './application/rate-limit/index';
export * from './application/delivery/index';
export * from './application/callbacks/index';
export * from './infrastructure/contact/index';
export * from './infrastructure/challenge/index';
export * from './infrastructure/rate-limit/index';
export * from './infrastructure/delivery/index';
export * from './infrastructure/callbacks/index';

// SPEC-002 stream entry points (SPEC-002 design §4). Each stream replaces its own `export {};` file.
export * from './domain/session/index';
export * from './domain/password/index';
export * from './domain/principal/index';
export * from './application/session/index';
export * from './application/password/index';
export * from './application/registration/index';
export * from './application/principal/index';
export * from './application/sign-in/index';
export * from './infrastructure/session/index';
export * from './infrastructure/password/index';
export * from './infrastructure/registration/index';
