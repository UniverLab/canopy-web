// SPDX-License-Identifier: Apache-2.0
/**
 * The visual e2e fixture Worker: the production Worker over an index the
 * fixture seeds through the indexer itself, so `wrangler dev` serves the
 * catalogue with fixture data and no network at all. The first request
 * runs one index build over the page tests' stub table into an
 * in-memory KV; every request after that is served from the index,
 * exactly as production serves from KV after a cron run.
 */
import { createWorker, type Env } from "../../src/index.js";
import { createGitHub } from "../../src/github.js";
import { runIndexer } from "../../src/indexer.js";
import { FakeCache, FakeKV, fakeFetch } from "../fakes.js";
import { officialStubs } from "../stubs.js";

const github = fakeFetch([...officialStubs()]);
const cache = new FakeCache();
const kv = new FakeKV();
const worker = createWorker({ fetchImpl: github.fetchImpl, cache });

let seeded: Promise<unknown> | null = null;

function seed(): Promise<unknown> {
  if (seeded === null) {
    seeded = runIndexer({
      github: createGitHub({ fetchImpl: github.fetchImpl, cache }),
      index: kv,
      authenticated: true,
    });
  }
  return seeded;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    await seed();
    return worker.fetch(req, { ...env, INDEX: kv });
  },
  scheduled: worker.scheduled,
};
