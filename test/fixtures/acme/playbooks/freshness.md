---
type: Playbook
title: Incident response — data freshness alert
description: Steps to triage a freshness alert on the orders pipeline.
tags: [oncall, incident]
timestamp: 2026-04-12T09:00:00Z
---

# Trigger

A freshness alert fires when [orders](/tables/orders.md) lags more than
30 minutes behind its SLA. Compare against the
[shipments table](/tables/shipments.md) if in doubt.

# Steps

1. Check the [ingestion job dashboard](https://example.com/dash).
2. Escalate per the [oncall rotation](#steps).
