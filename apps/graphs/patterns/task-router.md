---
title: Task router
summary: An experiment, a router judges the task by kind or complexity and sends it to a model suited to it.
status: experiment
implements: []
figure: task-router.figure.json
sources:
  - title: Building effective agents (Anthropic), routing
    url: https://www.anthropic.com/engineering/building-effective-agents
---

# Task router

This pattern is an experiment. The lab has not tested it properly.

## The problem

One model for every task wastes money on easy work and risks quality on hard work. Some tasks also need a quality that cheap models lack, such as visual taste.

## The pattern

Insert a router in front of the work. It reads the task, judges its kind or its complexity, and sends it down the branch that fits. Two implementers sit behind it on different harnesses and price points, and a cheap classifier decides which one earns each spec.

Anthropic names this workflow: "Routing classifies an input and directs it to a specialized followup task." It is a standard pattern.

Two things about the diagram are load-bearing and easy to get wrong.

**A failed cheap implement escalates to the expensive one. It does not go back to the router.** The router would classify the same spec the same way and send it back to the model that just failed, forever. Routing decisions based on the spec are stable by definition; only new information should produce a new decision.

**The check's fail edge also goes to the expensive implementer**, for the same reason: by the time a build is red, the cheap classification has been falsified by evidence.

**The router must be cheap.** A router as expensive as the expensive implementer means the high price is paid on every task, including the ones routed away from it.

## What we saw

Nothing yet, and that is the point of the label. The router is an untested hypothesis in Canopy, not an observed result.

The idea is an example, not a finding. Graphic design and assets would go to a model with strong taste, and everything else to cheap models. Opus 5.5 designed the univerlab.org site and its assets with the operator, which is why the hypothesis looks plausible to the lab. One project is not evidence that a router would choose well, or that it would cost less than a single model.

Risks worth testing: the router can misjudge, and every routing decision is itself a model call.

## In Canopy

The graph schema has a `router` node kind, and edges can carry a route label as their condition. A router graph sends each label to a different branch: the simple route to the cheap implementer, the complex route to the expensive one.

The figure shows the full shape with its two load-bearing edges. The cheap implementer's `fail` edge points at the expensive implementer, and the gate's `fail` edge does the same. Neither points back at the router.

No document in this catalogue uses a router yet, and this repository has no real file to copy an excerpt from. This page therefore implements no catalogue document.

## Try it

No catalogue document implements this pattern yet. If you build one, the repo README explains how to publish it. Keep the router cheap, keep both fail edges on the expensive branch, and test whether the router's judgments beat a single model before trusting it with a backlog.
