# Observed evaluation

Run `node bin/evaluate.mjs`. Sixteen fixed synthetic cases use the same Constitution and BTC reference price. Cases mix small valid orders, large exposure, closing/flipping, absent invalidation, invalid quantity and invalid equity.

Observed: 6 APPROVE, 5 RESIZE, 5 DENY. These are raw Referee decisions; RESIZE does not prove an exchange-executable replacement. No orders or payments occurred; external provider cost was zero. Latency is printed per run and depends on the machine.

Single-analyst, Bull/Bear, full-pipeline and narrative-disabled comparisons remain unmeasured. No live model outputs or independent ground-truth labels were available. False rejection rate and policy violations reaching submission are reported as null, not zero. A disabled executor cannot establish successful enforcement during real submission. These results do not establish returns or superiority.
