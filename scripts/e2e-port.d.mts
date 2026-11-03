// SPDX-License-Identifier: Apache-2.0
/**
 * Types for the e2e port helper, so the port contract test can import
 * the spreading and pinning directly.
 */
export const E2E_PORT_SPAN: number;
export function e2ePort(base: number, salt: string, envName: string): number;
