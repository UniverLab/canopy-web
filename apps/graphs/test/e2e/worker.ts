// SPDX-License-Identifier: Apache-2.0
/**
 * The visual e2e fixture Worker: the production Worker over the page tests'
 * stub table, so `wrangler dev` serves the catalogue with fixture data and
 * no network at all. The fake fetch answers every GitHub URL the pages ask
 * for and a miss is a 404, exactly as in the unit tests.
 */
import { createWorker } from "../../src/index.js";
import { FakeCache, fakeFetch } from "../fakes.js";
import { officialStubs } from "../stubs.js";

const github = fakeFetch([...officialStubs()]);

export default createWorker({ fetchImpl: github.fetchImpl, cache: new FakeCache() });
