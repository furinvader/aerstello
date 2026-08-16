import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { test } from '../fixtures/test';
import { connectDatabase } from '../support/database';
import { csrfHeaders,operationalData } from '../support/operational-api-data';
import { stateFor } from './financial-integrity.workflow-state';

const e2eBaseURL=`http://127.0.0.1:${process.env.E2E_WEB_PORT ?? '5173'}`;
const { Given, When, Then }=createBdd(test);

When('database writers cross an item billing boundary',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  const product=products.data.find(item=>item.name.de==='Helles')!;
  const orderResponse=await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}});
  expect(orderResponse.status()).toBe(201);
  const order=await orderResponse.json() as {tabId:string};
  const tab=await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json() as {items:{id:string;billingVersion:number}[]};
  const item=tab.items[0]!;
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;
  try{
    workflow.missingBillingIncrementError='';
    try{await database.query(`UPDATE order_items SET status='billed' WHERE id=$1`,[item.id])}catch(caught){workflow.missingBillingIncrementError=(caught as {code?:string}).code??''}
    workflow.invalidBillingVersionChangeError='';
    try{await database.query(`UPDATE order_items SET billing_version=billing_version+1 WHERE id=$1`,[item.id])}catch(caught){workflow.invalidBillingVersionChangeError=(caught as {code?:string}).code??''}
  }finally{await databaseResource.dispose()}
  const settlement=await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}});
  expect(settlement.status()).toBe(200);
  const bill=await settlement.json() as {id:string};
  const billedDatabaseResource=await connectDatabase(resources);const billedDatabase=billedDatabaseResource.client;
  let billedVersion=0;
  try{billedVersion=Number((await billedDatabase.query(`SELECT billing_version FROM order_items WHERE id=$1`,[item.id])).rows[0].billing_version)}finally{await billedDatabaseResource.dispose()}
  const reversal=await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Billing version regression'}});
  expect(reversal.status()).toBe(200);
  const reopenedTab=await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json() as {id:string;items:{id:string;billingVersion:number}[]};
  workflow.strictBillingVersions=[billedVersion,reopenedTab.items[0]!.billingVersion];
  const stale=await request.post(`/api/v1/order-items/${item.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Captured before billing',expectedBillingVersion:item.billingVersion}});
  workflow.strictBillingVoidConflict={status:stale.status(),code:((await stale.json()) as {error:{code:string}}).error.code};
  const secondSettlement=await request.post(`/api/v1/tabs/${reopenedTab.id}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}});
  expect(secondSettlement.status()).toBe(200);
  const verificationResource=await connectDatabase(resources);const verification=verificationResource.client;
  try{
    const billedAgain=await verification.query<{billingVersion:number}>(`SELECT billing_version AS "billingVersion" FROM order_items WHERE id=$1`,[item.id]);
    workflow.strictBillingVersions.push(billedAgain.rows[0]!.billingVersion);
  }finally{await verificationResource.dispose()}
});

Then('billing without an explicit version increment is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.missingBillingIncrementError).toBe('P0001')});

Then('the database advances the billing version exactly once',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.strictBillingVersions).toEqual([1,1,2])});

Then('billing version changes outside billing are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.invalidBillingVersionChangeError).toBe('P0001')});

Then('the stale item removal remains a billing conflict',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.strictBillingVoidConflict).toEqual({status:409,code:'ITEM_BILLING_CONFLICT'})});

When('database writers attempt to rewrite settled financial records',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  const product=products.data.find(item=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const settlement=await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}});
  expect(settlement.status()).toBe(200);
  const bill=await settlement.json() as {id:string};
  const databaseResource=await connectDatabase(resources);const database=databaseResource.client;
  const billSnapshot=`SELECT id,number::text,tab_id,guest_id,host_id,mutation_id,venue_name,venue_timezone,guest_name,room_name,host_name,total_cents,payment_method,payment_note,settled_at FROM bills WHERE id=$1`;
  const orderItemSnapshot=`SELECT id,batch_id,product_id,product_name,unit_price_cents,quantity,source,submitted_by_host,submitted_by_guest_session,provisional_until,guest_mutation_id,guest_expected_price_cents,guest_expected_product_version,billing_version,voided_at,voided_by_host,void_reason,host_void_mutation_id,host_void_expected_billing_version,guest_undo_mutation_id,created_at FROM order_items WHERE id=$1`;
  const billLineSnapshot=`SELECT id,bill_id,original_order_item_id,product_name,unit_price_cents,quantity,source FROM bill_items WHERE bill_id=$1`;
  let billUpdateError='';let billDeleteError='';let incompleteBillVoidError='';let unauditedBillVoidError='';let mismatchedBillVoidAuditError='';let mismatchedBillVoidAuditReachedCommit=false;let orderItemUpdateError='';let orderItemDeleteError='';let orderItemReopenError='';let settledTabReopenError='';let incompleteAuditedVoidError='';let incompleteAuditedVoidReachedCommit=false;let billLineUpdateError='';let billLineDeleteError='';let billsTruncateError='';let orderItemsTruncateError='';let billItemsTruncateError='';let billsTruncateTriggerEnabled=false;let orderItemsTruncateTriggerEnabled=false;let billItemsTruncateTriggerEnabled=false;let billBefore:unknown;let orderItemBefore:unknown;let billLineBefore:unknown;let orderItemId='';
  try{
    billBefore=(await database.query(billSnapshot,[bill.id])).rows[0];
    orderItemId=String((await database.query(`SELECT id FROM order_items WHERE bill_id=$1`,[bill.id])).rows[0].id);
    orderItemBefore=(await database.query(orderItemSnapshot,[orderItemId])).rows[0];
    billLineBefore=(await database.query(billLineSnapshot,[bill.id])).rows[0];
    try{await database.query(`UPDATE order_tabs SET status='open',closed_at=NULL WHERE id=$1`,[order.tabId])}catch(caught){settledTabReopenError=(caught as {code?:string}).code??''}
    try{await database.query(`UPDATE bills SET guest_name=guest_name||' rewritten' WHERE id=$1`,[bill.id])}catch(caught){billUpdateError=(caught as {code?:string}).code??''}
    try{await database.query('DELETE FROM bills WHERE id=$1',[bill.id])}catch(caught){billDeleteError=(caught as {code?:string}).code??''}
    try{await database.query('UPDATE bills SET voided_at=clock_timestamp() WHERE id=$1',[bill.id])}catch(caught){incompleteBillVoidError=(caught as {code?:string}).code??''}
    try{await database.query(`UPDATE bills SET voided_at=clock_timestamp(),void_reason='Missing audit',voided_by=$1,void_mutation_id=$2 WHERE id=$3`,[me.host.id,crypto.randomUUID(),bill.id])}catch(caught){unauditedBillVoidError=(caught as {code?:string}).code??''}
    const incompleteMutationId=crypto.randomUUID();
    const incompleteReason='Audited but still billed';
    try{
      await database.query('BEGIN');
      await database.query(`UPDATE bills SET voided_at=clock_timestamp(),void_reason=$1,voided_by=$2,void_mutation_id=$3 WHERE id=$4`,[incompleteReason,me.host.id,incompleteMutationId,bill.id]);
      await database.query(`INSERT INTO audit_events(actor_host_id,action,entity_type,entity_id,detail,created_at) VALUES ($1,'bill.voided','bill',$2,$3,clock_timestamp())`,[me.host.id,bill.id,JSON.stringify({reason:incompleteReason,mutationId:incompleteMutationId})]);
      incompleteAuditedVoidReachedCommit=true;
      await database.query('COMMIT');
    }catch(caught){incompleteAuditedVoidError=(caught as {code?:string}).code??'';await database.query('ROLLBACK')}
    const mismatchedMutationId=crypto.randomUUID();
    try{
      await database.query('BEGIN');
      await database.query(`UPDATE bills SET voided_at=clock_timestamp(),void_reason='Mismatched audit',voided_by=$1,void_mutation_id=$2 WHERE id=$3`,[me.host.id,mismatchedMutationId,bill.id]);
      await database.query(`INSERT INTO audit_events(actor_host_id,action,entity_type,entity_id,detail,created_at) VALUES (NULL,'bill.voided','bill',$1,$2,clock_timestamp())`,[bill.id,JSON.stringify({reason:'Mismatched audit',mutationId:mismatchedMutationId})]);
      mismatchedBillVoidAuditReachedCommit=true;
      await database.query('COMMIT');
    }catch(caught){mismatchedBillVoidAuditError=(caught as {code?:string}).code??'';await database.query('ROLLBACK')}
    try{await database.query('UPDATE order_items SET unit_price_cents=unit_price_cents+1 WHERE id=$1',[orderItemId])}catch(caught){orderItemUpdateError=(caught as {code?:string}).code??''}
    try{await database.query('DELETE FROM order_items WHERE id=$1',[orderItemId])}catch(caught){orderItemDeleteError=(caught as {code?:string}).code??''}
    try{await database.query(`UPDATE order_items SET status='open',bill_id=NULL WHERE id=$1`,[orderItemId])}catch(caught){orderItemReopenError=(caught as {code?:string}).code??''}
    try{await database.query('UPDATE bill_items SET quantity=quantity+1 WHERE bill_id=$1',[bill.id])}catch(caught){billLineUpdateError=(caught as {code?:string}).code??''}
    try{await database.query('DELETE FROM bill_items WHERE bill_id=$1',[bill.id])}catch(caught){billLineDeleteError=(caught as {code?:string}).code??''}
    try{await database.query('TRUNCATE bills CASCADE')}catch(caught){billsTruncateError=(caught as {code?:string}).code??''}
    try{await database.query('TRUNCATE order_items CASCADE')}catch(caught){orderItemsTruncateError=(caught as {code?:string}).code??''}
    try{await database.query('TRUNCATE bill_items')}catch(caught){billItemsTruncateError=(caught as {code?:string}).code??''}
    const truncateTriggers=await database.query<{tableName:string;enabled:boolean}>(
      `SELECT rel.relname AS "tableName",trg.tgenabled='O' AS enabled
         FROM pg_trigger trg
         JOIN pg_class rel ON rel.oid=trg.tgrelid
        WHERE trg.tgname IN ('bills_reject_truncate','order_items_reject_truncate','bill_items_reject_truncate')`,
    );
    const truncateTriggerEnabled=new Map(truncateTriggers.rows.map(trigger=>[trigger.tableName,trigger.enabled]));
    billsTruncateTriggerEnabled=truncateTriggerEnabled.get('bills')??false;
    orderItemsTruncateTriggerEnabled=truncateTriggerEnabled.get('order_items')??false;
    billItemsTruncateTriggerEnabled=truncateTriggerEnabled.get('bill_items')??false;
  }finally{await databaseResource.dispose()}
  const voidResponse=await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Verified immutable financial record'}});
  expect(voidResponse.status()).toBe(200);
  const verificationResource=await connectDatabase(resources);const verification=verificationResource.client;
  let voidAuditCount=0;let repeatedBillVoidError='';let billAfter:unknown;let orderItemAfter:unknown;let billLineAfter:unknown;let restoredOrderItemState={status:'',billId:null as string|null,billingVersion:-1};
  try{
    voidAuditCount=Number((await verification.query("SELECT count(*) FROM audit_events WHERE action='bill.voided' AND entity_type='bill' AND entity_id=$1",[bill.id])).rows[0].count);
    try{await verification.query(`UPDATE bills SET voided_at=clock_timestamp(),void_reason='Repeated void',voided_by=$1,void_mutation_id=$2 WHERE id=$3`,[me.host.id,crypto.randomUUID(),bill.id])}catch(caught){repeatedBillVoidError=(caught as {code?:string}).code??''}
    billAfter=(await verification.query(billSnapshot,[bill.id])).rows[0];
    orderItemAfter=(await verification.query(orderItemSnapshot,[orderItemId])).rows[0];
    billLineAfter=(await verification.query(billLineSnapshot,[bill.id])).rows[0];
    restoredOrderItemState=(await verification.query<{status:string;billId:string|null;billingVersion:number}>(`SELECT status,bill_id AS "billId",billing_version AS "billingVersion" FROM order_items WHERE id=$1`,[orderItemId])).rows[0]!;
  }finally{await verificationResource.dispose()}
  const restoredItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
  workflow.immutableFinancialResult={billUpdateError,billDeleteError,incompleteBillVoidError,unauditedBillVoidError,mismatchedBillVoidAuditError,mismatchedBillVoidAuditReachedCommit,repeatedBillVoidError,orderItemUpdateError,orderItemDeleteError,orderItemReopenError,settledTabReopenError,incompleteAuditedVoidError,incompleteAuditedVoidReachedCommit,billLineUpdateError,billLineDeleteError,billsTruncateError,orderItemsTruncateError,billItemsTruncateError,billsTruncateTriggerEnabled,orderItemsTruncateTriggerEnabled,billItemsTruncateTriggerEnabled,billBefore,billAfter,orderItemBefore,orderItemAfter,billLineBefore,billLineAfter,settlementStatus:settlement.status(),voidStatus:voidResponse.status(),voidAuditCount,restoredItemCount,restoredOrderItemState};
});

Then('direct bill header updates are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.billUpdateError).toBe('P0001')});

Then('direct bill header deletes are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.billDeleteError).toBe('P0001')});

Then('incomplete bill void transitions are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.incompleteBillVoidError).toBe('P0001')});

Then('unaudited bill void transitions are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.unauditedBillVoidError).toBe('P0001')});

Then('mismatched bill void audits are rejected at commit',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult).toMatchObject({mismatchedBillVoidAuditReachedCommit:true,mismatchedBillVoidAuditError:'P0001'})});

Then('repeated bill void transitions are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.repeatedBillVoidError).toBe('P0001')});

Then('direct billed order item updates are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.orderItemUpdateError).toBe('P0001')});

Then('direct billed order item deletes are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.orderItemDeleteError).toBe('P0001')});

Then('direct billed order item reopening is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.orderItemReopenError).toBe('P0001')});

Then('direct settled non-voided tab reopening is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.settledTabReopenError).toBe('P0001')});

Then('audited bill voids retaining billed items are rejected at commit',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult).toMatchObject({incompleteAuditedVoidReachedCommit:true,incompleteAuditedVoidError:'P0001'})});

Then('direct bill line updates are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.billLineUpdateError).toBe('P0001')});

Then('direct bill line deletes are rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.billLineDeleteError).toBe('P0001')});

Then('direct bill header truncation is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.billsTruncateError).toBe('P0001')});

Then('direct billed order item truncation is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.orderItemsTruncateError).toBe('P0001')});

Then('direct bill line truncation is rejected',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.billItemsTruncateError).toBe('P0001')});

Then('all financial truncate triggers remain enabled after reset',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult).toMatchObject({billsTruncateTriggerEnabled:true,orderItemsTruncateTriggerEnabled:true,billItemsTruncateTriggerEnabled:true})});

Then('the original settled financial snapshots remain unchanged',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult?.billBefore).toBeDefined();expect(workflow.immutableFinancialResult?.billAfter).toEqual(workflow.immutableFinancialResult?.billBefore);expect(workflow.immutableFinancialResult?.orderItemAfter).toEqual(workflow.immutableFinancialResult?.orderItemBefore);expect(workflow.immutableFinancialResult?.billLineAfter).toEqual(workflow.immutableFinancialResult?.billLineBefore)});

Then('normal settlement and audited bill reversal remain valid',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.immutableFinancialResult).toMatchObject({settlementStatus:200,voidStatus:200,voidAuditCount:1,restoredItemCount:1,restoredOrderItemState:{status:'open',billId:null,billingVersion:1}})});

When('direct database writers target committed historical evidence',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,guests,products}=await operationalData(page);
  const guest=guests.data.find(item=>item.name==='Anna Berger')!;
  const product=products.data.find(item=>item.name.de==='Helles')!;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};
  const voidResponse=await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Append-only evidence regression'}});
  expect(voidResponse.status()).toBe(200);

  const databaseResource=await connectDatabase(resources);
  const database=databaseResource.client;
  const errors:Record<string,string>={};
  let auditBefore:unknown;let auditAfter:unknown;let productVersionBefore:unknown;let productVersionAfter:unknown;
  let auditTruncateTriggerEnabled=false;let productVersionsTruncateTriggerEnabled=false;let productVersionCountBefore=0;let rolledBack=false;
  try{
    await database.query('BEGIN');
    auditBefore=(await database.query(`SELECT id,actor_host_id,action,entity_type,entity_id,detail,created_at FROM audit_events WHERE action='bill.voided' AND entity_id=$1`,[bill.id])).rows[0];
    productVersionBefore=(await database.query(`SELECT product_id,catalog_version,name,price_cents,enabled,self_service_only FROM product_versions WHERE product_id=$1 ORDER BY catalog_version DESC LIMIT 1`,[product.id])).rows[0];
    productVersionCountBefore=Number((await database.query(`SELECT count(*) FROM product_versions WHERE product_id=$1`,[product.id])).rows[0].count);
    const reject=async(name:string,statement:string,parameters:unknown[]=[])=>{
      await database.query(`SAVEPOINT ${name}`);
      try{await database.query(statement,parameters);errors[name]=''}catch(caught){errors[name]=(caught as {code?:string}).code??'';await database.query(`ROLLBACK TO SAVEPOINT ${name}`)}
      await database.query(`RELEASE SAVEPOINT ${name}`);
    };
    await reject('audit_update',`UPDATE audit_events SET detail='{}'::jsonb WHERE action='bill.voided' AND entity_id=$1`,[bill.id]);
    await reject('audit_delete',`DELETE FROM audit_events WHERE action='bill.voided' AND entity_id=$1`,[bill.id]);
    await reject('audit_truncate','TRUNCATE audit_events');
    await reject('product_version_update',`UPDATE product_versions SET price_cents=price_cents+1 WHERE product_id=$1`,[product.id]);
    await reject('product_version_delete',`DELETE FROM product_versions WHERE product_id=$1`,[product.id]);
    await reject('product_version_truncate','TRUNCATE product_versions');
    auditAfter=(await database.query(`SELECT id,actor_host_id,action,entity_type,entity_id,detail,created_at FROM audit_events WHERE action='bill.voided' AND entity_id=$1`,[bill.id])).rows[0];
    productVersionAfter=(await database.query(`SELECT product_id,catalog_version,name,price_cents,enabled,self_service_only FROM product_versions WHERE product_id=$1 ORDER BY catalog_version DESC LIMIT 1`,[product.id])).rows[0];
    const triggers=await database.query<{triggerName:string;enabled:boolean}>(
      `SELECT trg.tgname AS "triggerName",trg.tgenabled='O' AS enabled FROM pg_trigger trg WHERE trg.tgname IN ('audit_events_reject_truncate','product_versions_reject_truncate')`,
    );
    const enabled=new Map(triggers.rows.map(trigger=>[trigger.triggerName,trigger.enabled]));
    auditTruncateTriggerEnabled=enabled.get('audit_events_reject_truncate')??false;
    productVersionsTruncateTriggerEnabled=enabled.get('product_versions_reject_truncate')??false;
    await database.query('ROLLBACK');rolledBack=true;
  }finally{if(!rolledBack)await database.query('ROLLBACK');await databaseResource.dispose()}

  const productUpdate=await request.patch(`/api/v1/products/${product.id}`,{headers:csrfHeaders,data:{name:product.name,...(product.description?{description:product.description}:{}),priceCents:product.priceCents+1,categoryId:product.categoryId,enabled:product.enabled,selfServiceOnly:product.selfServiceOnly,expectedVersion:product.version}});
  const verificationResource=await connectDatabase(resources);const verification=verificationResource.client;
  let voidAuditCount=0;let productVersionCountAfter=0;
  try{
    voidAuditCount=Number((await verification.query(`SELECT count(*) FROM audit_events WHERE action='bill.voided' AND entity_id=$1`,[bill.id])).rows[0].count);
    productVersionCountAfter=Number((await verification.query(`SELECT count(*) FROM product_versions WHERE product_id=$1`,[product.id])).rows[0].count);
  }finally{await verificationResource.dispose()}
  workflow.historicalEvidenceResult={errors,auditBefore,auditAfter,productVersionBefore,productVersionAfter,auditTruncateTriggerEnabled,productVersionsTruncateTriggerEnabled,voidStatus:voidResponse.status(),voidAuditCount,productUpdateStatus:productUpdate.status(),productVersionCountBefore,productVersionCountAfter};
});

Then('audit and catalog history reject updates, deletes, and truncation',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.historicalEvidenceResult?.errors).toEqual({audit_update:'P0001',audit_delete:'P0001',audit_truncate:'P0001',product_version_update:'P0001',product_version_delete:'P0001',product_version_truncate:'P0001'});
});

Then('the original historical evidence remains unchanged',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.historicalEvidenceResult?.auditBefore).toBeDefined();
  expect(workflow.historicalEvidenceResult?.auditAfter).toEqual(workflow.historicalEvidenceResult?.auditBefore);
  expect(workflow.historicalEvidenceResult?.productVersionBefore).toBeDefined();
  expect(workflow.historicalEvidenceResult?.productVersionAfter).toEqual(workflow.historicalEvidenceResult?.productVersionBefore);
});

Then('historical truncate guards remain enabled after reset',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.historicalEvidenceResult).toMatchObject({auditTruncateTriggerEnabled:true,productVersionsTruncateTriggerEnabled:true})});

Then('normal audited voids and catalog history insertion remain valid',async({ scenarioState })=>{const workflow=stateFor(scenarioState);
  expect(workflow.historicalEvidenceResult).toMatchObject({voidStatus:200,voidAuditCount:1,productUpdateStatus:200});
  expect(workflow.historicalEvidenceResult!.productVersionCountAfter).toBe(workflow.historicalEvidenceResult!.productVersionCountBefore+1);
});

When('guest archival races with reversal of their bill',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,products}=await operationalData(page);const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const product=products.data.find(item=>item.name.de==='Helles')!;const room=rooms.data.find(item=>item.name==='102')!;workflow.billArchiveRaceStatuses=[];
  for(let attempt=0;attempt<8;attempt+=1){
    const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:`Bill race guest ${attempt}`,roomId:room.id,language:'de'}})).json() as {id:string;version:number};
    const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
    const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};
    const [archive,reversal]=await Promise.all([request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:guest.version}}),request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Race correction'}})]);
    workflow.billArchiveRaceStatuses.push([archive.status(),reversal.status()]);
  }
});

Then('the bill reversal succeeds before or after guest archival',async({ scenarioState })=>{const workflow=stateFor(scenarioState);for(const statuses of workflow.billArchiveRaceStatuses)expect([[204,200],[409,200]]).toContainEqual(statuses)});

When('the administrator reverses a bill for an archived guest',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const {request,me,products}=await operationalData(page);const rooms=await (await request.get('/api/v1/rooms')).json() as {data:{id:string;name:string}[]};const product=products.data.find(item=>item.name.de==='Helles')!;const room=rooms.data.find(item=>item.name==='102')!;
  workflow.archivedGuestCorrectionName='Archived correction guest';
  const guest=await (await request.post('/api/v1/guests',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),name:workflow.archivedGuestCorrectionName,roomId:room.id,language:'de'}})).json() as {id:string;version:number};
  workflow.archivedGuestCorrectionId=guest.id;
  const order=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};
  const bill=await (await request.post(`/api/v1/tabs/${order.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};
  expect((await request.delete(`/api/v1/guests/${guest.id}`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedVersion:guest.version}})).status()).toBe(204);
  workflow.archivedGuestBillVoidStatus=(await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Archived guest correction'}})).status();
  workflow.archivedGuestRestoredItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;
});

Then('the archived guest bill is voided and its item is restored',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.archivedGuestBillVoidStatus).toBe(200);expect(workflow.archivedGuestRestoredItemCount).toBe(1)});

Then('the corrected archived guest tab opens from host orders without enabling new orders',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  const request=page.context().request;
  const activeGuests=await (await request.get('/api/v1/guests')).json() as {data:{id:string}[]};
  expect(activeGuests.data.some(guest=>guest.id===workflow.archivedGuestCorrectionId)).toBe(false);
  await page.goto('/app/orders');
  const corrected=page.locator('.tab-card').filter({hasText:workflow.archivedGuestCorrectionName});
  await expect(corrected).toContainText('102');
  await corrected.getByRole('link',{name:/Bearbeiten|Modifica|Edit/}).click();
  await expect(page).toHaveURL(new RegExp(`/app/orders/new\\?guest=${workflow.archivedGuestCorrectionId}$`));
  await expect(page.locator('.page-header h1')).toHaveText(workflow.archivedGuestCorrectionName);
  await expect(page.locator('.open-tab')).toContainText('Helles');
  await expect(page.locator('.tab-pill')).toContainText(/1 Artikel|1 articolo|1 item/);
  await expect(page.locator('.product-tile').filter({hasText:'Helles'})).toBeDisabled();
  await expect(page.getByRole('button',{name:/Bestellung buchen|Registra ordine|Submit order/})).toBeDisabled();
  await expect(page.getByRole('button',{name:/Abrechnen|Incassa|Settle/})).toBeEnabled();
});

When('the host settles the corrected archived guest tab',async({page})=>{
  await page.getByRole('button',{name:/Abrechnen|Incassa|Settle/}).click();
  const modal=page.locator('.modal');
  await modal.locator('.choice-grid').getByRole('button',{name:/Bar|Contanti|Cash/}).click();
  await modal.getByRole('button',{name:/Abrechnen|Incassa|Settle/,exact:true}).click();
});

Then('the host reaches its corrected bill',async({scenarioState, page})=>{const workflow=stateFor(scenarioState);
  await expect(page).toHaveURL(/\/app\/bills\//);
  await expect(page.locator('.bill-meta')).toContainText(workflow.archivedGuestCorrectionName);
  await expect(page.locator('.bill-void-marker')).toHaveCount(0);
  const tab=await (await page.context().request.get(`/api/v1/guests/${workflow.archivedGuestCorrectionId}/tab`)).json() as {itemCount:number};
  expect(tab.itemCount).toBe(0);
});

When('the administrator reverses a bill onto a tab at the money limit',async({resources, scenarioState, page})=>{const workflow=stateFor(scenarioState);const {request,me,guests,products}=await operationalData(page);const guest=guests.data.find(item=>item.name==='Anna Berger')!;const product=products.data.find(item=>item.name.de==='Helles')!;const billedOrder=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const bill=await (await request.post(`/api/v1/tabs/${billedOrder.tabId}/settle`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),expectedItemCount:1,expectedTotalCents:product.priceCents,paymentMethod:'cash'}})).json() as {id:string};const openOrder=await (await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).json() as {tabId:string};const databaseResource=await connectDatabase(resources);const database=databaseResource.client;try{await database.query('UPDATE order_items SET unit_price_cents=2147483647 WHERE tab_id=$1 AND status IN (\'open\',\'provisional\')',[openOrder.tabId])}finally{await databaseResource.dispose()}workflow.overflowBillVoidStatus=(await request.post(`/api/v1/bills/${bill.id}/void`,{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),reason:'Required correction at limit'}})).status();workflow.overflowBillTabItemCount=((await (await request.get(`/api/v1/guests/${guest.id}/tab`)).json()) as {itemCount:number}).itemCount;workflow.overflowOverviewStatuses=[(await request.get('/api/v1/orders')).status(),(await request.get('/api/v1/guests')).status()];workflow.overflowPostCorrectionOrderStatus=(await request.post('/api/v1/order-batches',{headers:csrfHeaders,data:{mutationId:crypto.randomUUID(),originHostId:me.host.id,guestId:guest.id,catalogVersion:products.catalogVersion,capturedAt:new Date().toISOString(),items:[{productId:product.id,quantity:1}]}})).status()});

Then('the correction succeeds and restores the billed item',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.overflowBillVoidStatus).toBe(200);expect(workflow.overflowBillTabItemCount).toBe(2)});

Then('normal additions remain blocked while the corrected tab exceeds the limit',async({ scenarioState })=>{const workflow=stateFor(scenarioState);expect(workflow.overflowOverviewStatuses).toEqual([200,200]);expect(workflow.overflowPostCorrectionOrderStatus).toBe(409)});
