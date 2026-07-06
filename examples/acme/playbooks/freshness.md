---
type: Playbook
title: Incident response — data freshness alert
description: Steps to triage a freshness alert on the orders pipeline.
tags: [oncall, incident]
timestamp: 2026-04-12T09:00:00Z
---

# Trigger

A freshness alert fires when [orders](/tables/orders.md) lags more than
30 minutes behind its SLA.

# Steps

1. Check the [ingestion job dashboard](https://example.com/dash).
2. Confirm upstream row counts against [customers](/tables/customers.md).
3. Escalate to the data platform on-call if lag exceeds 2 hours.
