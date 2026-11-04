// SPDX-License-Identifier: Apache-2.0
// The d4eb8558 contract vectors, shared by the web tests.

export const CODE = "7K3QH-M9P2X";
export const CODE_NORMALIZED = "7K3QHM9P2X";
export const HOST_ID = "76805a63a6980c18";
export const DEVICE_ID = "bfcba2b742a807bb";
export const DEVICE_SPKI_B64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1lqTl3yqPRsIGFL/V6eeRl8WYFdzBLrq1QXdOkhYnPNQGF6JU3LfYiHqOhN1V+Rz/dtnVfBb1QfDxTP86ckShQ==";
export const HOST_SPKI_B64 =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEAhfmF/C2RDkoJ4+WmZ5pojpPLBUr321s32bluAKC1O0ZSn3ry5dxLS3aPKhaqHZaVvRfx1hZllLyiXxlMG5XlA==";
export const MAC_INIT = "kpAbG/Gfg4QfoIVR/ey/Iop5TcNowq4mIrO29NyTL6o=";
export const MAC_OK = "1dCqDScWc5KVefuLcEqLHPTPVfNvO1QsjcW/kytm/RE=";
export const OFFER_SIG =
  "IjIQ+FdCMvFYZfODE7OpflYnZlg0aWjc3GWfDBK9CLk5f8TWURvcsDpoNbvvh4Iaz/7MUmkEo6571C6asBI6UQ==";
export const ANSWER_SDP = "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n";
export const ANSWER_SIG =
  "cj0zq+BTNi23U+rvtXTSwl080GqqqkLVV057yGTxdQ4NCb5zrQhsKlbBvncvBx7hfXHjfv9Ete03GD6tJiLFMg==";

export const nonceB = (): Uint8Array => Uint8Array.from({ length: 16 }, (_, i) => i);
export const nonceH = (): Uint8Array => Uint8Array.from({ length: 16 }, (_, i) => i + 16);
