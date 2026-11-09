# CN14 role service

Implement the authenticated concurrent A2A role execution/result/receipt service in new `src/delivery-role-service.js` and `test/delivery-role-service.test.js` only, plus these owned notes. Preserve all inherited dirty files and do not perform Git writes, live model/account/target actions, or shared service restarts.

Read the parent role-service brief, project map and current capability/artifact handoffs before coding. Send root exact host API before editing. Existing A2A code is read-only unless root gives an exact narrow scope grant. The service must keep product output private until trusted CandidateStore publication, use real existing stores/handlers/capability checks, and record durable observed execution proof. Test with disposable authenticated local fixtures and `env -u NODE_TEST_CONTEXT`.
