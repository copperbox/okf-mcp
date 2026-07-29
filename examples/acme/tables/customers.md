---
type: BigQuery Table
title: Customers
description: One row per registered customer.
resource: https://console.cloud.google.com/bigquery?p=acme&d=sales&t=customers
tags: [sales, customers]
timestamp: 2026-05-28T00:00:00Z
---

# Schema

| Column        | Type   | Description                    |
|---------------|--------|--------------------------------|
| `customer_id` | STRING | Unique customer identifier.    |
| `email`       | STRING | Primary contact email address. |

Referenced by [orders](orders.md).
