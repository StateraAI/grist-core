import { ALL_PERMISSION_PROPS } from 'app/common/ACLPermissions';
import { ACLRuleCollection, SPECIAL_RULES_TABLE_ID } from 'app/common/ACLRuleCollection';
import { ActionGroup } from 'app/common/ActionGroup';
import { createEmptyActionSummary } from 'app/common/ActionSummary';
import { Query } from 'app/common/ActiveDocAPI';
import { ApiError } from 'app/common/ApiError';
import { AddRecord, BulkAddRecord, BulkColValues, BulkRemoveRecord, BulkUpdateRecord } from 'app/common/DocActions';
import { RemoveRecord, ReplaceTableData, UpdateRecord } from 'app/common/DocActions';
import { CellValue, ColValues, DocAction, getTableId, isSchemaAction } from 'app/common/DocActions';
import { TableDataAction, UserAction } from 'app/common/DocActions';
import { DocData } from 'app/common/DocData';
import { UserOverride } from 'app/common/DocListAPI';
import { ErrorWithCode } from 'app/common/ErrorWithCode';
import { AclMatchInput, InfoEditor, InfoView } from 'app/common/GranularAccessClause';
import { UserInfo } from 'app/common/GranularAccessClause';
import { getSetMapValue, isObject, pruneArray } from 'app/common/gutil';
import { canView, Role } from 'app/common/roles';
import { FullUser } from 'app/common/UserAPI';
import { HomeDBManager } from 'app/gen-server/lib/HomeDBManager';
import { compileAclFormula } from 'app/server/lib/ACLFormula';
import { DocClients } from 'app/server/lib/DocClients';
import { getDocSessionAccess, getDocSessionUser, OptDocSession } from 'app/server/lib/DocSession';
import * as log from 'app/server/lib/log';
import { IPermissionInfo, PermissionInfo, PermissionSetWithContext } from 'app/server/lib/PermissionInfo';
import { TablePermissionSetWithContext } from 'app/server/lib/PermissionInfo';
import { integerParam } from 'app/server/lib/requestUtils';
import { getRelatedRows, getRowIdsFromDocAction } from 'app/server/lib/RowAccess';
import cloneDeep = require('lodash/cloneDeep');
import fromPairs = require('lodash/fromPairs');
import get = require('lodash/get');

// tslint:disable:no-bitwise

// Actions that add/update/remove/replace rows.
const ACTION_WITH_TABLE_ID = new Set(['AddRecord', 'BulkAddRecord', 'UpdateRecord', 'BulkUpdateRecord',
                                      'RemoveRecord', 'BulkRemoveRecord',
                                      'ReplaceTableData', 'TableData',
                                    ]);
type DataAction = AddRecord | BulkAddRecord | UpdateRecord | BulkUpdateRecord |
  RemoveRecord | BulkRemoveRecord | ReplaceTableData | TableDataAction;

// Check if action adds/updates/removes/replaces rows.
function isDataAction(a: UserAction): a is DataAction {
  return ACTION_WITH_TABLE_ID.has(String(a[0]));
}

// Check if a tableId is that of an ACL table.  Currently just _grist_ACLRules and
// _grist_ACLResources are accepted.
function isAclTable(tableId: string): boolean {
  return ['_grist_ACLRules', '_grist_ACLResources'].includes(tableId);
}

// A list of key metadata tables that need special handling.  Other metadata tables may
// refer to material in some of these tables but don't need special handling.
// TODO: there are other metadata tables that would need access control, or redesign -
// specifically _grist_Attachments.
const STRUCTURAL_TABLES = new Set(['_grist_Tables', '_grist_Tables_column', '_grist_Views',
                                   '_grist_Views_section', '_grist_Views_section_field',
                                   '_grist_ACLResources', '_grist_ACLRules']);

// Actions that won't be allowed (yet) for a user with nuanced access to a document.
// A few may be innocuous, but generally I've put them in this list if there are problems
// tracking down what table the refer to, or they could allow creation/modification of a
// formula.
const SPECIAL_ACTIONS = new Set(['InitNewDoc',
                                 'EvalCode',
                                 'SetDisplayFormula',
                                 'UpdateSummaryViewSection',
                                 'DetachSummaryViewSection',
                                 'GenImporterView',
                                 'TransformAndFinishImport',
                                 'AddView',
                                 'CopyFromColumn',
                                 'AddHiddenColumn',
                                ]);

// Odd-ball actions marked as deprecated or which seem unlikely to be used.
const SURPRISING_ACTIONS = new Set([
                                    'RemoveView',
                                    'AddViewSection',
                                   ]);

// Actions we'll allow unconditionally for now.
const OK_ACTIONS = new Set(['Calculate']);

/**
 * Granular access for a single bundle, in different phases.
 */
export interface GranularAccessForBundle {
  canApplyBundle(): Promise<void>;
  appliedBundle(): Promise<void>;
  finishedBundle(): Promise<void>;
  sendDocUpdateForBundle(actionGroup: ActionGroup): Promise<void>;
}

/**
 *
 * Manage granular access to a document.  This allows nuances other than the coarse
 * owners/editors/viewers distinctions.  Nuances are stored in the _grist_ACLResources
 * and _grist_ACLRules tables.
 *
 * When the document is being modified, the object's GranularAccess is called at various
 * steps of the process to check access rights.  The GranularAccess object stores some
 * state for an in-progress modification, to allow some caching of calculations across
 * steps and clients.  We expect modifications to be serialized, and the following
 * pattern of calls for modifications:
 *
 *  - assertCanMaybeApplyUserActions(), called with UserActions for an initial access check.
 *    Since not all checks can be done without analyzing UserActions into DocActions,
 *    it is ok for this call to pass even if a more definitive test later will fail.
 *  - getGranularAccessForBundle(), called once a possible bundle has been prepared
 *    (the UserAction has been compiled to DocActions).
 *  - canApplyBundle(), called when DocActions have been produced from UserActions,
 *    but before those DocActions have been applied to the DB.  If fails, the modification
 *    will be abandoned.
 *  - appliedBundle(), called when DocActions have been applied to the DB, but before
 *    those changes have been sent to clients.
 *  - sendDocUpdateforBundle() is called once a bundle has been applied, to notify
 *    client of changes.
 *  - finishedBundle(), called when completely done with modification and any needed
 *    client notifications, whether successful or failed.
 *
 *
 */
export class GranularAccess implements GranularAccessForBundle {
  // The collection of all rules.
  private _ruler = new Ruler(this);

  // Cache of user attributes associated with the given docSession. It's a WeakMap, to allow
  // garbage-collection once docSession is no longer in use.
  private _userAttributesMap = new WeakMap<OptDocSession, UserAttributes>();
  private _prevUserAttributesMap: WeakMap<OptDocSession, UserAttributes>|undefined;

  // When broadcasting a sequence of DocAction[]s, this contains the state of
  // affected rows for the relevant table before and after each DocAction.  It
  // may contain some unaffected rows as well.  Other metadata is included if
  // needed.
  private _steps: Promise<ActionStep[]>|null = null;
  // Access control is done sequentially, bundle by bundle.  This is the current bundle.
  private _activeBundle: {
    docSession: OptDocSession,
    userActions: UserAction[],
    docActions: DocAction[],
    undo: DocAction[],
    // Flag tracking whether a set of actions have been applied to the database or not.
    applied: boolean,
    // Flag for whethere user actions mention a rule change (clients are asked to reload
    // in this case).
    hasDeliberateRuleChange: boolean,
  }|null;

  public constructor(
    private _docData: DocData,
    private _docClients: DocClients,
    private _fetchQueryFromDB: (query: Query) => Promise<TableDataAction>,
    private _recoveryMode: boolean,
    private _homeDbManager: HomeDBManager | null,
    private _docId: string) {
  }

  public getGranularAccessForBundle(docSession: OptDocSession, docActions: DocAction[], undo: DocAction[],
                                    userActions: UserAction[]): void {
    if (this._activeBundle) { throw new Error('Cannot start a bundle while one is already in progress'); }
    this._activeBundle = {
      docSession, docActions, undo, userActions,
      applied: false, hasDeliberateRuleChange: false,
    };
    this._activeBundle.hasDeliberateRuleChange =
      scanActionsRecursively(userActions, (a) => isAclTable(String(a[1])));
  }

  /**
   * Update granular access from DocData.
   */
  public async update() {
    await this._ruler.update(this._docData);

    // Also clear the per-docSession cache of user attributes.
    this._userAttributesMap = new WeakMap();
  }

  /**
   * Check whether user can carry out query.
   */
  public hasQueryAccess(docSession: OptDocSession, query: Query) {
    return this.hasTableAccess(docSession, query.tableId);
  }

  public getUser(docSession: OptDocSession): Promise<UserInfo> {
    return this._getUser(docSession);
  }

  /**
   * Check whether user has any access to table.
   */
  public async hasTableAccess(docSession: OptDocSession, tableId: string) {
    const pset = await this.getTableAccess(docSession, tableId);
    return this.getReadPermission(pset) !== 'deny';
  }

  /**
   * Called after UserAction[]s have been applied in the sandbox, and DocAction[]s have been
   * computed, but before we have committed those DocAction[]s to the database.  If this
   * throws an exception, the sandbox changes will be reverted.
   */
  public async canApplyBundle() {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const {docActions, docSession} = this._activeBundle;
    if (this._activeBundle.hasDeliberateRuleChange && !await this.isOwner(docSession)) {
      throw new ErrorWithCode('ACL_DENY', 'Only owners can modify access rules');
    }
    if (this._ruler.haveRules()) {
      await Promise.all(
        docActions.map((action, actionIdx) => this._checkIncomingDocAction({docSession, action, actionIdx})));
    }

    if (this._recoveryMode) {
      // Don't do any further checking in recovery mode.
      return;
    }

    // If the actions change any rules, verify that we'll be able to handle the changed rules. If
    // they are to cause an error, reject the action to avoid forcing user into recovery mode.
    // WATCH OUT - this will trigger for "passive" changes caused by tableId/colId renames.
    if (docActions.some(docAction => isAclTable(getTableId(docAction)))) {
      // Create a tmpDocData with just the tables we care about, then update docActions to it.
      const tmpDocData: DocData = new DocData(
        (tableId) => { throw new Error("Unexpected DocData fetch"); }, {
          _grist_Tables: this._docData.getTable('_grist_Tables')!.getTableDataAction(),
          _grist_Tables_column: this._docData.getTable('_grist_Tables_column')!.getTableDataAction(),
          _grist_ACLResources: this._docData.getTable('_grist_ACLResources')!.getTableDataAction(),
          _grist_ACLRules: this._docData.getTable('_grist_ACLRules')!.getTableDataAction(),
        });
      for (const da of docActions) {
        tmpDocData.receiveAction(da);
      }

      // Use the post-actions data to process the rules collection, and throw error if that fails.
      const ruleCollection = new ACLRuleCollection();
      await ruleCollection.update(tmpDocData, {log, compile: compileAclFormula});
      if (ruleCollection.ruleError) {
        throw new ApiError(ruleCollection.ruleError.message, 400);
      }
      try {
        ruleCollection.checkDocEntities(tmpDocData);
      } catch (err) {
        throw new ApiError(err.message, 400);
      }
    }
  }

  /**
   * This should be called after each action bundle has been applied to the database,
   * but before the actions are broadcast to clients.  It will set us up to be able
   * to efficiently filter those broadcasts.
   *
   * We expect actions bundles for a document to be applied+broadcast serially (the
   * broadcasts can be parallelized, but should complete before moving on to further
   * document mutation).
   */
  public async appliedBundle() {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const {docActions} = this._activeBundle;
    this._activeBundle.applied = true;
    if (!this._ruler.haveRules()) { return; }
    // Check if a table that affects user attributes has changed.  If so, put current
    // attributes aside for later comparison, and clear cache.
    const attrs = new Set([...this._ruler.ruleCollection.getUserAttributeRules().values()].map(r => r.tableId));
    const attrChange = docActions.some(docAction => attrs.has(getTableId(docAction)));
    if (attrChange) {
      this._prevUserAttributesMap = this._userAttributesMap;
      this._userAttributesMap = new WeakMap();
    }
    // If there's a schema change, zap permission cache.
    const schemaChange = docActions.some(docAction => isSchemaAction(docAction));
    if (attrChange || schemaChange) {
      this._ruler.clearCache();
    }
  }

  /**
   * This should be called once an action bundle has been broadcast to
   * all clients (or the bundle has been denied).  It will clean up
   * any temporary state cached for filtering those broadcasts.
   */
  public async finishedBundle() {
    if (!this._activeBundle) { return; }
    if (this._activeBundle.applied) {
      const {docActions} = this._activeBundle;
      await this._updateRules(docActions);
    }
    this._steps = null;
    this._prevUserAttributesMap = undefined;
    this._activeBundle = null;
  }

  /**
   * Filter DocActions to be sent to a client.
   */
  public async filterOutgoingDocActions(docSession: OptDocSession, docActions: DocAction[]): Promise<DocAction[]> {
    // If the user requested a rule change, trigger a reload.
    if (this._activeBundle?.hasDeliberateRuleChange) {
      // TODO: could avoid reloading in many cases, especially for an owner who has full
      // document access.
      throw new ErrorWithCode('NEED_RELOAD', 'document needs reload, access rules changed');
    }

    // Optimize case where there are no rules to enforce.
    if (!this._ruler.haveRules()) { return docActions; }

    // If user attributes have changed, trigger a reload.
    await this._checkUserAttributes(docSession);

    const actions = await Promise.all(
      docActions.map((action, actionIdx) => this._filterOutgoingDocAction({docSession, action, actionIdx})));
    return ([] as DocAction[]).concat(...actions);
  }

  /**
   * Filter an ActionGroup to be sent to a client.
   */
  public async filterActionGroup(docSession: OptDocSession, actionGroup: ActionGroup): Promise<ActionGroup> {
    if (await this.allowActionGroup(docSession, actionGroup)) { return actionGroup; }
    // For now, if there's any nuance at all, suppress the summary and description.
    // TODO: create an empty action summary, to be sure not to leak anything important.
    const result: ActionGroup = { ...actionGroup };
    result.actionSummary = createEmptyActionSummary();
    result.desc = '';
    return result;
  }

  /**
   * Check whether an ActionGroup can be sent to the client.  TODO: in future, we'll want
   * to filter acceptible parts of ActionGroup, rather than denying entirely.
   */
  public async allowActionGroup(docSession: OptDocSession, actionGroup: ActionGroup): Promise<boolean> {
    return this.canReadEverything(docSession);
  }

  /**
   * Check if user may be able to apply a list of actions.  Throws if
   * user cannot apply an action.  Returns true if a user can apply an
   * action, or false if we need to defer making that determination
   * until the data engine translates the user actions to doc actions.
   */
  public async assertCanMaybeApplyUserActions(docSession: OptDocSession, actions: UserAction[]): Promise<boolean> {
    for (const action of actions) {
      if (!await this.assertCanMaybeApplyUserAction(docSession, action)) { return false; }
    }
    return true;
  }

  /**
   * Check if user may be able to apply a given action.  Throws if
   * user cannot apply the action.  Returns true if a user can apply an
   * action, or false if we need to defer making that determination
   * until the data engine translates the user actions to doc actions.
   */
  public async assertCanMaybeApplyUserAction(docSession: OptDocSession, a: UserAction|DocAction): Promise<boolean> {
    const name = a[0] as string;
    if (OK_ACTIONS.has(name)) { return true; }
    if (SPECIAL_ACTIONS.has(name)) {
      if (await this.hasNuancedAccess(docSession)) {
        throw new ErrorWithCode('ACL_DENY', `Blocked by access rules: '${name}' actions need uncomplicated access`);
      }
      return true;
    }
    if (SURPRISING_ACTIONS.has(name)) {
      if (!await this.hasFullAccess(docSession)) {
        throw new ErrorWithCode('ACL_DENY', `Blocked by access rules: '${name}' actions need full access`);
      }
      return true;
    }
    if (a[0] === 'ApplyUndoActions') {
      return this.assertCanMaybeApplyUserActions(docSession, a[1] as UserAction[]);
    } else if (a[0] === 'ApplyDocActions') {
      return this.assertCanMaybeApplyUserActions(docSession, a[1] as UserAction[]);
    } else if (isDataAction(a)) {
      const tableId = getTableId(a);
      if (tableId.startsWith('_grist_')) {
        return false;  // have to look closely
      }
      const tableAccess = await this.getTableAccess(docSession, tableId);
      const accessCheck = getAccessForActionType(a, 'fatal');
      accessCheck.get(tableAccess);  // will throw if access denied.
      return true;
    } else {
      return false;  // have to look closely
    }
  }

  /**
   * Check whether access is simple, or there are granular nuances that need to be
   * worked through.  Currently if there are no owner-only tables, then everyone's
   * access is simple and without nuance.
   */
  public async hasNuancedAccess(docSession: OptDocSession): Promise<boolean> {
    if (!this._ruler.haveRules()) { return false; }
    return !await this.hasFullAccess(docSession);
  }

  /**
   * Check if user is explicitly permitted to download/copy document.
   * They may be allowed to download in any case, see canCopyEverything.
   */
  public async hasFullCopiesPermission(docSession: OptDocSession): Promise<boolean> {
    const permInfo = await this._getAccess(docSession);
    return permInfo.getColumnAccess(SPECIAL_RULES_TABLE_ID, 'FullCopies').perms.read === 'allow';
  }

  /**
   * Check if user may view Access Rules.
   */
  public async hasAccessRulesPermission(docSession: OptDocSession): Promise<boolean> {
    const permInfo = await this._getAccess(docSession);
    return permInfo.getColumnAccess(SPECIAL_RULES_TABLE_ID, 'AccessRules').perms.read === 'allow';
  }

  /**
   * Check whether user can read everything in document.  Checks both home-level and doc-level
   * permissions.
   */
  public async canReadEverything(docSession: OptDocSession): Promise<boolean> {
    const access = await this._getNominalAccess(docSession);
    if (!canView(access)) { return false; }
    const permInfo = await this._getAccess(docSession);
    return this.getReadPermission(permInfo.getFullAccess()) === 'allow';
  }

  /**
   * An odd little right for findColFromValues and autocomplete.  Allow if user can read
   * all data, or is an owner.  Might be worth making a special permission.
   */
  public async canScanData(docSession: OptDocSession): Promise<boolean> {
    return await this.isOwner(docSession) || await this.canReadEverything(docSession);
  }

  /**
   * Check whether user can copy everything in document.  Owners can always copy
   * everything, even if there are rules that specify they cannot.
   *
   * There's a small wrinkle about access rules.  The content
   * of _grist_ACLRules and Resources are only send to clients that are owners,
   * but could be copied by others by other means (e.g. download) as long as all
   * tables or columns are readable. This seems ok (no private info involved),
   * just a bit inconsistent.
   */
  public async canCopyEverything(docSession: OptDocSession): Promise<boolean> {
    return await this.hasFullCopiesPermission(docSession) ||
      await this.canReadEverything(docSession);
  }

  /**
   * Check whether user has full access to the document.  Currently that is interpreted
   * as equivalent owner-level access to the document.
   * TODO: uses of this method should be checked to see if they can be fleshed out
   * now we have more of the ACL implementation done.
   */
  public hasFullAccess(docSession: OptDocSession): Promise<boolean> {
    return this.isOwner(docSession);
  }

  /**
   * Check whether user has owner-level access to the document.
   */
  public async isOwner(docSession: OptDocSession): Promise<boolean> {
    const access = await this._getNominalAccess(docSession);
    return access === 'owners';
  }

  /**
   *
   * If the user does not have access to the full document, we need to filter out
   * parts of the document metadata.  For simplicity, we overwrite rather than
   * filter for now, so that the overall structure remains consistent.  We overwrite:
   *
   *   - names, textual ids, formulas, and other textual options
   *   - foreign keys linking columns/views/sections back to a forbidden table
   *
   * On the client, a page with a blank name will be marked gracefully as unavailable.
   *
   * Some information leaks, for example the existence of private tables and how
   * many columns they had, and something of the relationships between them. Long term,
   * it could be better to zap rows entirely, and do the work of cleaning up any cross
   * references to them.
   *
   */
  public async filterMetaTables(docSession: OptDocSession,
                                tables: {[key: string]: TableDataAction}): Promise<{[key: string]: TableDataAction}> {
    // If user has right to read everything, return immediately.
    if (await this.canReadEverything(docSession)) { return tables; }
    // If we are going to modify metadata, make a copy.
    tables = JSON.parse(JSON.stringify(tables));

    const permInfo = await this._getAccess(docSession);
    const censor = new CensorshipInfo(permInfo, this._ruler.ruleCollection, tables,
                                      await this.hasAccessRulesPermission(docSession));

    for (const tableId of STRUCTURAL_TABLES) {
      censor.apply(tables[tableId]);
    }
    return tables;
  }

  /**
   * Distill the clauses for the given session and table, to figure out the
   * access level and any row-level access functions needed.
   */
  public async getTableAccess(docSession: OptDocSession, tableId: string): Promise<TablePermissionSetWithContext> {
    return (await this._getAccess(docSession)).getTableAccess(tableId);
  }

  /**
   * Modify table data in place, removing any rows or columns to which access
   * is not granted.
   */
  public async filterData(docSession: OptDocSession, data: TableDataAction) {
    const permInfo = await this._getAccess(docSession);
    const cursor: ActionCursor = {docSession, action: data, actionIdx: null};
    const tableId = getTableId(data);
    if (this.getReadPermission(permInfo.getTableAccess(tableId)) === 'mixed') {
      await this._filterRowsAndCells(cursor, data, data, readAccessCheck);
    }

    // Filter columns, omitting any to which the user has no access, regardless of rows.
    this._filterColumns(
      data[3],
      (colId) => this.getReadPermission(permInfo.getColumnAccess(tableId, colId)) !== 'deny');
  }

  public async getUserOverride(docSession: OptDocSession): Promise<UserOverride|undefined> {
    await this._getUser(docSession);
    return this._getUserAttributes(docSession).override;
  }

  public getReadPermission(ps: PermissionSetWithContext) {
    return ps.perms.read;
  }

  public assertCanRead(ps: PermissionSetWithContext) {
    readAccessCheck.throwIfDenied(ps);
  }

  /**
   * Broadcast document changes to all clients, with appropriate filtering.
   */
  public async sendDocUpdateForBundle(actionGroup: ActionGroup) {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const { docActions, docSession } = this._activeBundle;
    const client = docSession && docSession.client || null;
    const message = { actionGroup, docActions };
    await this._docClients.broadcastDocMessage(client, 'docUserAction',
                                               message,
                                               (docSession) => this._filterDocUpdate(docSession, message));
  }

  /**
   * Get the role the session user has for this document.  User may be overridden,
   * in which case the role of the override is returned.
   */
  private async _getNominalAccess(docSession: OptDocSession): Promise<Role> {
    const linkParameters = docSession.authorizer?.getLinkParameters() || {};
    if (linkParameters.aclAsUserId || linkParameters.aclAsUser) {
      const info = await this._getUser(docSession);
      return info.Access as Role;
    }
    return getDocSessionAccess(docSession);
  }

  /**
   * This filters a message being broadcast to all clients to be appropriate for one
   * particular client, if that client may need some material filtered out.
   */
  private async _filterDocUpdate(docSession: OptDocSession, message: {
    actionGroup: ActionGroup,
    docActions: DocAction[]
  }) {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    if (!this._ruler.haveRules() && !this._activeBundle.hasDeliberateRuleChange) {
      return message;
    }
    const result = {
      actionGroup: await this.filterActionGroup(docSession, message.actionGroup),
      docActions: await this.filterOutgoingDocActions(docSession, message.docActions),
    };
    if (result.docActions.length === 0) { return null; }
    return result;
  }

  private async _updateRules(docActions: DocAction[]) {
    // If there is a rule change, redo from scratch for now.
    // TODO: this is placeholder code. Should deal with connected clients.
    if (docActions.some(docAction => isAclTable(getTableId(docAction)))) {
      await this.update();
      return;
    }
    if (!this._ruler.haveRules()) { return; }
    // If there is a schema change, redo from scratch for now.
    if (docActions.some(docAction => isSchemaAction(docAction))) {
      await this.update();
    }
  }

  /**
   * Strip out any denied columns from an action.  Returns null if nothing is left.
   * accessCheck may throw if denials are fatal.
   */
  private _pruneColumns(a: DocAction, permInfo: IPermissionInfo, tableId: string,
                        accessCheck: AccessCheck): DocAction|null {
    if (a[0] === 'RemoveRecord' || a[0] === 'BulkRemoveRecord') {
      return a;
    } else if (a[0] === 'AddRecord' || a[0] === 'BulkAddRecord' || a[0] === 'UpdateRecord' ||
               a[0] === 'BulkUpdateRecord' || a[0] === 'ReplaceTableData' || a[0] === 'TableData') {
      const na = cloneDeep(a);
      this._filterColumns(na[3], (colId) => accessCheck.get(permInfo.getColumnAccess(tableId, colId)) !== 'deny');
      if (Object.keys(na[3]).length === 0) { return null; }
      return na;
    } else if (a[0] === 'AddColumn' || a[0] === 'RemoveColumn' || a[0] === 'RenameColumn' ||
               a[0] === 'ModifyColumn') {
      const colId: string = a[2];
      if (accessCheck.get(permInfo.getColumnAccess(tableId, colId)) === 'deny') { return null; }
    } else {
      // Remaining cases of AddTable, RemoveTable, RenameTable should have
      // been handled at the table level.
    }
    return a;
  }

  /**
   * Strip out any denied rows from an action.  The action may be rewritten if rows
   * become allowed or denied during the action.  An action to add newly-allowed
   * rows may be included, or an action to remove newly-forbidden rows.  The result
   * is a list rather than a single action.  It may be the empty list.
   */
  private async _pruneRows(cursor: ActionCursor): Promise<DocAction[]> {
    const {action} = cursor;
    // This only deals with Record-related actions.
    if (!isDataAction(action)) { return [action]; }

    // Get before/after state for this action.  Broadcasts to other users can make use of the
    // same state, so we share it (and only compute it if needed).
    const {rowsBefore, rowsAfter} = await this._getRowsBeforeAndAfter(cursor);

    // Figure out which rows were forbidden to this session before this action vs
    // after this action.  We need to know both so that we can infer the state of the
    // client and send the correct change.
    const ids = new Set(getRowIdsFromDocAction(action));
    const forbiddenBefores = new Set(await this._getForbiddenRows(cursor, rowsBefore, ids));
    const forbiddenAfters = new Set(await this._getForbiddenRows(cursor, rowsAfter, ids));

    /**
     * For rows forbidden before and after: just remove them.
     * For rows allowed before and after: just leave them unchanged.
     * For rows that were allowed before and are now forbidden:
     *   - strip them from the current action.
     *   - add a BulkRemoveRecord for them.
     * For rows that were forbidden before and are now allowed:
     *   - remove them from the current action.
     *   - add a BulkAddRecord for them.
     */

    const removals = new Set<number>();      // rows to remove from current action.
    const forceAdds = new Set<number>();     // rows to add, that were previously stripped.
    const forceRemoves = new Set<number>();  // rows to remove, that have become forbidden.
    for (const id of ids) {
      const forbiddenBefore = forbiddenBefores.has(id);
      const forbiddenAfter = forbiddenAfters.has(id);
      if (!forbiddenBefore && !forbiddenAfter) { continue; }
      if (forbiddenBefore && forbiddenAfter) {
        removals.add(id);
        continue;
      }
      // If we reach here, then access right to the row changed and we have fancy footwork to do.
      if (forbiddenBefore) {
        // The row was forbidden and now is allowed.  That's trivial if the row was just added.
        if (action[0] === 'AddRecord' || action[0] === 'BulkAddRecord' ||
            action[0] === 'ReplaceTableData' || action[0] === 'TableData') {
          continue;
        }
        // Otherwise, strip the row from the current action.
        removals.add(id);
        if (action[0] === 'UpdateRecord' || action[0] === 'BulkUpdateRecord') {
          // For updates, we need to send the entire row as an add, since the client
          // doesn't know anything about it yet.
          forceAdds.add(id);
        } else {
          // Remaining cases are [Bulk]RemoveRecord.
        }
      } else {
        // The row was allowed and now is forbidden.
        // If the action is a removal, that is just right.
        if (action[0] === 'RemoveRecord' || action[0] === 'BulkRemoveRecord') { continue; }
        // Otherwise, strip the row from the current action.
        removals.add(id);
        if (action[0] === 'UpdateRecord' || action[0] === 'BulkUpdateRecord') {
          // For updates, we need to remove the entire row.
          forceRemoves.add(id);
        } else {
          // Remaining cases are add-like actions.
        }
      }
    }
    // Execute our cunning plans for DocAction revisions.
    const revisedDocActions = [
      this._makeAdditions(rowsAfter, forceAdds),
      this._removeRows(action, removals),
      this._makeRemovals(rowsAfter, forceRemoves),
    ].filter(isObject);

    // Return the results, also applying any cell-level access control.
    for (const action of revisedDocActions) {
      await this._filterRowsAndCells({...cursor, action}, rowsAfter, rowsAfter, readAccessCheck);
    }
    return revisedDocActions;
  }

  /**
   * Like _pruneRows, but fails immediately if access to any row is forbidden.
   * The accessCheck supplied should throw an error on denial.
   */
  private async _checkRows(cursor: ActionCursor, accessCheck: AccessCheck): Promise<void> {
    const {action} = cursor;
    // This check applies to data changes only.
    if (!isDataAction(action)) { return; }
    const {rowsBefore, rowsAfter} = await this._getRowsForRecAndNewRec(cursor);
    await this._filterRowsAndCells(cursor, rowsBefore, rowsAfter, accessCheck);
  }

  private async _getRowsBeforeAndAfter(cursor: ActionCursor) {
    const {rowsBefore, rowsAfter} = await this._getStep(cursor);
    if (!rowsBefore || !rowsAfter) { throw new Error('Logic error: no rows available'); }
    return {rowsBefore, rowsAfter};
  }

  private async _getRowsForRecAndNewRec(cursor: ActionCursor) {
    const steps = await this._getSteps();
    if (cursor.actionIdx === null) { throw new Error('No step available'); }
    const {rowsBefore, rowsLast} = steps[cursor.actionIdx];
    if (!rowsBefore) { throw new Error('Logic error: no previous rows available'); }
    if (rowsLast) {
      return {rowsBefore, rowsAfter: rowsLast};
    }
    // When determining whether to apply an action, we choose to make newRec refer to the
    // state at the end of the entire bundle.  So we look for the last pair of row snapshots
    // for the same table.
    // TODO: there's a problem that this could alias rows if row ids were reused within the
    // same bundle. It is kind of a slippery idea. Likewise, column renames are slippery.
    // We could solve a lot of slipperiness by having newRec not transition across schema
    // changes, but we don't really have the option because formula updates happen late.
    let tableId = getTableId(rowsBefore);
    let last = cursor.actionIdx;
    for (let i = last + 1; i < steps.length; i++) {
      const act = steps[i].action;
      if (getTableId(act) !== tableId) { continue; }
      if (act[0] === 'RenameTable') {
        tableId = act[2];
        continue;
      }
      last = i;
    }
    const rowsAfter = steps[cursor.actionIdx].rowsLast = steps[last].rowsAfter;
    if (!rowsAfter) { throw new Error('Logic error: no next rows available'); }
    return {rowsBefore, rowsAfter};
  }

  /**
   * Modify action in place, scrubbing any rows and cells to which access is not granted.
   */
  private async _filterRowsAndCells(cursor: ActionCursor, rowsBefore: TableDataAction, rowsAfter: TableDataAction,
                                    accessCheck: AccessCheck) {
    const ruler = await this._getRuler(cursor);
    const {docSession, action} = cursor;
    if (action && isSchemaAction(action)) {
      return [];
    }

    const rec = new RecordView(rowsBefore, undefined);
    const newRec = new RecordView(rowsAfter, undefined);
    const input: AclMatchInput = {user: await this._getUser(docSession), rec, newRec};

    const [, tableId, , colValues] = action;
    const rowIds = getRowIdsFromDocAction(action);
    const toRemove: number[] = [];

    let censorAt: (colId: string, idx: number) => void;
    if (colValues === undefined) {
      censorAt = () => 1;
    } else if (Array.isArray(action[2])) {
      censorAt = (colId, idx) => (colValues as BulkColValues)[colId][idx] = 'CENSORED';  // TODO Pick a suitable value
    } else {
      censorAt = (colId) => (colValues as ColValues)[colId] = 'CENSORED';  // TODO Pick a suitable value
    }

    // These map an index of a row in the action to its index in rowsBefore and in rowsAfter.
    let getRecIndex: (idx: number) => number|undefined = (idx) => idx;
    let getNewRecIndex: (idx: number) => number|undefined = (idx) => idx;
    if (action !== rowsBefore) {
      const recIndexes = new Map(rowsBefore[2].map((rowId, idx) => [rowId, idx]));
      getRecIndex = (idx) => recIndexes.get(rowIds[idx]);
      const newRecIndexes = new Map(rowsAfter[2].map((rowId, idx) => [rowId, idx]));
      getNewRecIndex = (idx) => newRecIndexes.get(rowIds[idx]);
    }

    for (let idx = 0; idx < rowIds.length; idx++) {
      rec.index = getRecIndex(idx);
      newRec.index = getNewRecIndex(idx);

      const rowPermInfo = new PermissionInfo(ruler.ruleCollection, input);
      // getTableAccess() evaluates all column rules for THIS record. So it's really rowAccess.
      const rowAccess = rowPermInfo.getTableAccess(tableId);
      const access = accessCheck.get(rowAccess);
      if (access === 'deny') {
        toRemove.push(idx);
      } else if (access !== 'allow' && colValues) {
        // Go over column rules.
        for (const colId of Object.keys(colValues)) {
          const colAccess = rowPermInfo.getColumnAccess(tableId, colId);
          if (accessCheck.get(colAccess) === 'deny') {
            censorAt(colId, idx);
          }
        }
      }
    }

    if (toRemove.length > 0) {
      if (rowsBefore === action) {
        this._removeRowsAt(toRemove, rowsBefore[2], rowsBefore[3]);
      } else {
        // Artificially introduced removals are ok, otherwise this is suspect.
        if (action[0] !== 'RemoveRecord' && action[0] !== 'BulkRemoveRecord') {
          throw new Error('Unexpected row removal');
        }
      }
    }
  }

  // Compute which of the row ids supplied are for rows forbidden for this session.
  private async _getForbiddenRows(cursor: ActionCursor, data: TableDataAction, ids: Set<number>): Promise<number[]> {
    const ruler = await this._getRuler(cursor);
    const rec = new RecordView(data, undefined);
    const input: AclMatchInput = {user: await this._getUser(cursor.docSession), rec};

    const [, tableId, rowIds] = data;
    const toRemove: number[] = [];
    for (let idx = 0; idx < rowIds.length; idx++) {
      rec.index = idx;
      if (!ids.has(rowIds[idx])) { continue; }

      const rowPermInfo = new PermissionInfo(ruler.ruleCollection, input);
      // getTableAccess() evaluates all column rules for THIS record. So it's really rowAccess.
      const rowAccess = rowPermInfo.getTableAccess(tableId);
      if (this.getReadPermission(rowAccess) === 'deny') {
        toRemove.push(rowIds[idx]);
      }
    }
    return toRemove;
  }

  /**
   * Removes the toRemove rows (indexes, not row ids) from the rowIds list and from
   * the colValues structure.
   *
   * toRemove must be sorted, lowest to highest.
   */
  private _removeRowsAt(toRemove: number[], rowIds: number[], colValues: BulkColValues|undefined) {
    if (toRemove.length > 0) {
      pruneArray(rowIds, toRemove);
      if (colValues) {
        for (const values of Object.values(colValues)) {
          pruneArray(values, toRemove);
        }
      }
    }
  }

  /**
   * Remove columns from a ColumnValues parameter of certain DocActions, using a predicate for
   * which columns to keep.
   * Will retain manualSort columns regardless of wildcards.
   */
  private _filterColumns(data: BulkColValues|ColValues, shouldInclude: (colId: string) => boolean) {
    for (const colId of Object.keys(data)) {
      if (colId !== 'manualSort' && !shouldInclude(colId)) {
        delete data[colId];
      }
    }
  }

  /**
   * Get PermissionInfo for the user represented by the given docSession. The returned object
   * allows evaluating access level as far as possible without considering specific records.
   *
   * The result is cached in a WeakMap, and PermissionInfo does its own caching, so multiple calls
   * to this._getAccess(docSession).someMethod() will reuse already-evaluated results.
   */
  private async _getAccess(docSession: OptDocSession): Promise<PermissionInfo> {
    // TODO The intent of caching is to avoid duplicating rule evaluations while processing a
    // single request. Caching based on docSession is riskier since those persist across requests.
    return this._ruler.getAccess(docSession);
  }

  private _getUserAttributes(docSession: OptDocSession): UserAttributes {
    // TODO Same caching intent and caveat as for _getAccess
    return getSetMapValue(this._userAttributesMap as Map<OptDocSession, UserAttributes>, docSession,
                          () => new UserAttributes());
  }

  /**
   * Check whether user attributes have changed.  If so, prompt client
   * to reload the document, since we aren't sophisticated enough to
   * figure out the changes to send.
   */
  private async _checkUserAttributes(docSession: OptDocSession) {
    if (!this._prevUserAttributesMap) { return; }
    const userAttrBefore = this._prevUserAttributesMap.get(docSession);
    if (!userAttrBefore) { return; }
    await this._getAccess(docSession);  // Makes sure user attrs have actually been computed.
    const userAttrAfter = this._getUserAttributes(docSession);
    for (const [tableId, rec] of Object.entries(userAttrAfter.rows)) {
      const prev = userAttrBefore.rows[tableId];
      if (!prev || JSON.stringify(prev.toJSON()) !== JSON.stringify(rec.toJSON())) {
        throw new ErrorWithCode('NEED_RELOAD', 'document needs reload, user attributes changed');
      }
    }
  }

  /**
   * Construct the UserInfo needed for evaluating rules. This also enriches the user with values
   * created by user-attribute rules.
   */
  private async _getUser(docSession: OptDocSession): Promise<UserInfo> {
    const linkParameters = docSession.authorizer?.getLinkParameters() || {};
    let access: Role | null;
    let fullUser: FullUser | null;
    const attrs = this._getUserAttributes(docSession);
    access = getDocSessionAccess(docSession);

    // If aclAsUserId/aclAsUser is set, then override user for acl purposes.
    if (linkParameters.aclAsUserId || linkParameters.aclAsUser) {
      if (access !== 'owners') { throw new Error('only an owner can override user'); }
      if (attrs.override) {
        // Used cached properties.
        access = attrs.override.access;
        fullUser = attrs.override.user;
      } else {
        // Look up user information in database.
        if (!this._homeDbManager) { throw new Error('database required'); }
        const dbUser = linkParameters.aclAsUserId ?
          (await this._homeDbManager.getUser(integerParam(linkParameters.aclAsUserId))) :
          (await this._homeDbManager.getUserByLogin(linkParameters.aclAsUser));
        const docAuth = dbUser && await this._homeDbManager.getDocAuthCached({
          urlId: this._docId,
          userId: dbUser.id
        });
        access = docAuth?.access || null;
        fullUser = dbUser && this._homeDbManager.makeFullUser(dbUser) || null;
        attrs.override = { access, user: fullUser };
      }
    } else {
      fullUser = getDocSessionUser(docSession);
    }
    const user: UserInfo = {};
    user.Access = access;
    user.UserID = fullUser?.id || null;
    user.Email = fullUser?.email || null;
    user.Name = fullUser?.name || null;
    // If viewed from a websocket, collect any link parameters included.
    // TODO: could also get this from rest api access, just via a different route.
    user.LinkKey = linkParameters;
    // Include origin info if accessed via the rest api.
    // TODO: could also get this for websocket access, just via a different route.
    user.Origin = docSession.req?.get('origin') || null;

    if (this._ruler.ruleCollection.ruleError && !this._recoveryMode) {
      // It is important to signal that the doc is in an unexpected state,
      // and prevent it opening.
      throw this._ruler.ruleCollection.ruleError;
    }

    for (const clause of this._ruler.ruleCollection.getUserAttributeRules().values()) {
      if (clause.name in user) {
        log.warn(`User attribute ${clause.name} ignored; conflicts with an existing one`);
        continue;
      }
      if (attrs.rows[clause.name]) {
        user[clause.name] = attrs.rows[clause.name];
        continue;
      }
      let rec = new EmptyRecordView();
      let rows: TableDataAction|undefined;
      try {
        // Use lodash's get() that supports paths, e.g. charId of 'a.b' would look up `user.a.b`.
        // TODO: add indexes to db.
        rows = await this._fetchQueryFromDB({
          tableId: clause.tableId,
          filters: { [clause.lookupColId]: [get(user, clause.charId)] }
        });
      } catch (e) {
        log.warn(`User attribute ${clause.name} failed`, e);
      }
      if (rows && rows[2].length > 0) { rec = new RecordView(rows, 0); }
      user[clause.name] = rec;
      attrs.rows[clause.name] = rec;
    }
    return user;
  }

  /**
   * Remove a set of rows from a DocAction.  If the DocAction ends up empty, null is returned.
   * If the DocAction needs modification, it is copied first - the original is never
   * changed.
   */
  private _removeRows(a: DocAction, rowIds: Set<number>): DocAction|null {
    // If there are no rows, there's nothing to do.
    if (isSchemaAction(a)) { return a; }
    if (a[0] === 'AddRecord' || a[0] === 'UpdateRecord' || a[0] === 'RemoveRecord') {
      return rowIds.has(a[2]) ? null : a;
    }
    const na = cloneDeep(a);
    const [, , oldIds, bulkColValues] = na;
    const mask = oldIds.map((id, idx) => rowIds.has(id) ? idx : false).filter(v => v !== false) as number[];
    this._removeRowsAt(mask, oldIds, bulkColValues);
    if (oldIds.length === 0) { return null; }
    return na;
  }

  /**
   * Make a BulkAddRecord for a set of rows.
   */
  private _makeAdditions(data: TableDataAction, rowIds: Set<number>): BulkAddRecord|null {
    if (rowIds.size === 0) { return null; }
    // TODO: optimize implementation, this does an unnecessary clone.
    const notAdded = data[2].filter(id => !rowIds.has(id));
    const partialData = this._removeRows(data, new Set(notAdded)) as TableDataAction|null;
    if (partialData === null) { return partialData; }
    return ['BulkAddRecord', partialData[1], partialData[2], partialData[3]];
  }

  /**
   * Make a BulkRemoveRecord for a set of rows.
   */
  private _makeRemovals(data: TableDataAction, rowIds: Set<number>): BulkRemoveRecord|null {
    if (rowIds.size === 0) { return null; }
    return ['BulkRemoveRecord', getTableId(data), [...rowIds]];
  }

  private async _getSteps(): Promise<Array<ActionStep>> {
    if (!this._steps) {
      this._steps = this._getUncachedSteps().catch(e => {
        log.error('step computation failed:', e);
        throw e;
      });
    }
    return this._steps;
  }

  /**
   * Prepare to compute intermediate states of rows, as
   * this._steps.  The computation should happen only if
   * needed, which depends on the rules and actions.  The computation
   * uses the state of the database, and so depends on whether the
   * docActions have already been applied to the database or not, as
   * determined by the this._applied flag, which should never be
   * changed during any possible use of this._steps.
   */
  private async _getUncachedSteps(): Promise<Array<ActionStep>> {
    if (!this._activeBundle) { throw new Error('no active bundle'); }
    const {docActions, undo, applied} = this._activeBundle;
    // For row access work, we'll need to know the state of affected rows before and
    // after the actions.
    // First figure out what rows in which tables are touched during the actions.
    const rows = new Map(getRelatedRows(applied ? [...undo].reverse() : docActions));
    // Populate a minimal in-memory version of the database with these rows.
    const docData = new DocData(
      (tableId) => this._fetchQueryFromDB({tableId, filters: {id: [...rows.get(tableId)!]}}),
      null,
    );
    // In some cases, we track metadata.
    const needMeta = docActions.some(a => isSchemaAction(a) || getTableId(a).startsWith('_grist_'));
    const metaDocData = needMeta ? new DocData(
      async (tableId) => {
        const result = this._docData.getTable(tableId)?.getTableDataAction();
        if (!result) { throw new Error('surprising load'); }
        return result;
      },
      null,
    ) : this._docData;
    // Load pre-existing rows touched by the bundle.
    await Promise.all([...rows.keys()].map(tableId => docData.syncTable(tableId)));
    // If we need metadata, we read the structural tables.
    if (needMeta) {
      await Promise.all([...STRUCTURAL_TABLES].map(tableId => metaDocData.syncTable(tableId)));
    }
    if (applied) {
      // Apply the undo actions, since the docActions have already been applied to the db.
      for (const docAction of [...undo].reverse()) { docData.receiveAction(docAction); }
      if (needMeta) {
        for (const docAction of [...undo].reverse()) { metaDocData.receiveAction(docAction); }
      }
    }
    let meta = {} as {[key: string]: TableDataAction};
    // Metadata is stored as a hash of TableDataActions.
    if (needMeta) {
      for (const tableId of STRUCTURAL_TABLES) {
        meta[tableId] = cloneDeep(metaDocData.getTable(tableId)!.getTableDataAction());
      }
    }

    // Now step forward, storing the before and after state for the table
    // involved in each action.  We'll use this to compute row access changes.
    // For simple changes, the rows will be just the minimal set needed.
    // This could definitely be optimized.  E.g. for pure table updates, these
    // states could be extracted while applying undo actions, with no need for
    // a forward pass.  And for a series of updates to the same table, there'll
    // be duplicated before/after states that could be optimized.
    const steps = new Array<ActionStep>();
    let ruler = this._ruler;
    if (needMeta && applied) {
      // Rules may have changed - back them off to a copy of their original state.
      ruler = new Ruler(this);
      ruler.update(metaDocData);
    }
    let replaceRuler = false;
    for (const docAction of docActions) {
      const tableId = getTableId(docAction);
      const tableData = docData.getTable(tableId);
      const rowsBefore = cloneDeep(tableData?.getTableDataAction() || ['TableData', '', [], {}] as TableDataAction);
      docData.receiveAction(docAction);
      // If table is deleted, state afterwards doesn't matter.
      const rowsAfter = docData.getTable(tableId) ? cloneDeep(tableData?.getTableDataAction() || ['TableData', '', [], {}] as TableDataAction) : rowsBefore;
      const step: ActionStep = {action: docAction, rowsBefore, rowsAfter};
      if (needMeta) {
        step.metaBefore = meta;
        if (STRUCTURAL_TABLES.has(tableId)) {
          metaDocData.receiveAction(docAction);
          // make shallow copy of all tables
          meta = {...meta};
          // replace table just modified with a deep copy
          meta[tableId] = cloneDeep(metaDocData.getTable(tableId)!.getTableDataAction());
        }
        step.metaAfter = meta;
        // replaceRuler logic avoids updating rules between paired changes of resources and rules.
        if (isAclTable(tableId)) {
          replaceRuler = true;
        } else if (replaceRuler) {
          ruler = new Ruler(this);
          ruler.update(metaDocData);
          replaceRuler = false;
        }
        step.ruler = ruler;
      }
      steps.push(step);
    }
    return steps;
  }

  /**
   * Tailor the information about a change reported to a given client. The action passed in
   * is never modified. The actions output may differ in the following ways:
   *   - Tables, columns or rows may be omitted if the client does not have access to them.
   *   - Columns in structural metadata tables may be cleared if the client does not have
   *     access to the resources they relate to.
   *   - Columns in the _grist_Views table may be cleared or uncleared depending on changes
   *     in other metadata tables.
   *   - Rows may be inserted if the client newly acquires access to them via an update.
   * TODO: I think that column rules controlling READ access using rec are not fully supported
   * yet.  They work on first load, but if READ access is lost/gained updates won't be made.
   */
  private async _filterOutgoingDocAction(cursor: ActionCursor): Promise<DocAction[]> {
    const {action} = cursor;
    const tableId = getTableId(action);
    const permInfo = await this._getStepAccess(cursor);
    const tableAccess = permInfo.getTableAccess(tableId);
    const access = this.getReadPermission(tableAccess);
    const results: DocAction[] = [];
    if (access === 'deny') {
      // filter out this data.
    } else if (access === 'allow') {
      results.push(action);
    } else if (access === 'mixedColumns') {
      const act = this._pruneColumns(action, permInfo, tableId, readAccessCheck);
      if (act) { results.push(act); }
    } else {
      // The remainder is the mixed condition.
      for (const act of await this._pruneRows(cursor)) {
        const prunedAct = this._pruneColumns(act, permInfo, tableId, readAccessCheck);
        if (prunedAct) { results.push(prunedAct); }
      }
    }
    const secondPass: DocAction[] = [];
    for (const act of results) {
      if (STRUCTURAL_TABLES.has(getTableId(act)) && isDataAction(act)) {
        await this._filterOutgoingStructuralTables(cursor, act, secondPass);
      } else {
        secondPass.push(act);
      }
    }
    return secondPass;
  }

  private async _filterOutgoingStructuralTables(cursor: ActionCursor, act: DataAction, results: DocAction[]) {
    // Filter out sensitive columns from tables.
    const permissionInfo = await this._getStepAccess(cursor);
    const step = await this._getStep(cursor);
    if (!step.metaAfter) { throw new Error('missing metadata'); }
    act = cloneDeep(act); // Don't change original action.
    const ruler = await this._getRuler(cursor);
    const censor = new CensorshipInfo(permissionInfo,
                                      ruler.ruleCollection,
                                      step.metaAfter,
                                      await this.hasAccessRulesPermission(cursor.docSession));
    if (censor.apply(act)) {
      results.push(act);
    }

    // There's a wrinkle to deal with. If we just added or removed a section, we need to
    // reconsider whether the view containing it is visible.
    if (getTableId(act) === '_grist_Views_section') {
      if (!step.metaBefore) { throw new Error('missing prior metadata'); }
      const censorBefore = new CensorshipInfo(permissionInfo,
                                              ruler.ruleCollection,
                                              step.metaBefore,
                                              await this.hasAccessRulesPermission(cursor.docSession));
      // For all views previously censored, if they are now uncensored,
      // add an UpdateRecord to expose them.
      for (const v of censorBefore.censoredViews) {
        if (!censor.censoredViews.has(v)) {
          const table = step.metaAfter._grist_Views;
          const idx = table[2].indexOf(v);
          const name = table[3].name[idx];
          results.push(['UpdateRecord', '_grist_Views', v, {name}]);
        }
      }
      // For all views currently censored, if they were previously uncensored,
      // add an UpdateRecord to censor them.
      for (const v of censor.censoredViews) {
        if (!censorBefore.censoredViews.has(v)) {
          results.push(['UpdateRecord', '_grist_Views', v, {name: ''}]);
        }
      }
    }
  }

  private async _checkIncomingDocAction(cursor: ActionCursor): Promise<void> {
    const {action} = cursor;
    const accessCheck = getAccessForActionType(action, 'fatal');
    const tableId = getTableId(action);
    const permInfo = await this._getStepAccess(cursor);
    const tableAccess = permInfo.getTableAccess(tableId);
    const access = accessCheck.get(tableAccess);
    if (access === 'allow') { return; }
    if (access === 'mixedColumns') {
      // Somewhat abusing prune method by calling it with an access function that
      // throws on denial.
      this._pruneColumns(action, permInfo, tableId, accessCheck);
    }
    // The remainder is the mixed condition.
    await this._checkRows(cursor, accessCheck);
    // Somewhat abusing prune method by calling it with an access function that
    // throws on denial.
    this._pruneColumns(action, permInfo, tableId, accessCheck);
  }

  private async _getRuler(cursor: ActionCursor) {
    if (cursor.actionIdx === null) { return this._ruler; }
    if (!this._steps) {
      throw new Error("No steps available");
    }
    const step = await this._getStep(cursor);
    return step.ruler || this._ruler;
  }

  private async _getStepAccess(cursor: ActionCursor) {
    const step = await this._getStep(cursor);
    if (step.ruler) { return step.ruler.getAccess(cursor.docSession); }
    // No rule changes!
    return this._getAccess(cursor.docSession);
  }

  private async _getStep(cursor: ActionCursor) {
    if (cursor.actionIdx === null) { throw new Error('No step available'); }
    const steps = await this._getSteps();
    return steps[cursor.actionIdx];
  }
}

/**
 * A snapshots of rules and permissions at during one of more steps within a bundle.
 */
export class Ruler {
  // The collection of all rules, with helpful accessors.
  public ruleCollection = new ACLRuleCollection();

  // Cache of PermissionInfo associated with the given docSession. It's a WeakMap, so should allow
  // both to be garbage-collected once docSession is no longer in use.
  private _permissionInfoMap = new WeakMap<OptDocSession, Promise<PermissionInfo>>();

  public constructor(private _owner: RulerOwner) {}

  public async getAccess(docSession: OptDocSession): Promise<PermissionInfo> {
    // TODO The intent of caching is to avoid duplicating rule evaluations while processing a
    // single request. Caching based on docSession is riskier since those persist across requests.
    return getSetMapValue(this._permissionInfoMap as Map<OptDocSession, Promise<PermissionInfo>>, docSession,
      async () => new PermissionInfo(this.ruleCollection, {user: await this._owner.getUser(docSession)}));
  }

  /**
   * Update granular access from DocData.
   */
  public async update(docData: DocData) {
    await this.ruleCollection.update(docData, {log, compile: compileAclFormula});

    // Also clear the per-docSession cache of rule evaluations.
    this.clearCache();
  }

  public clearCache() {
    this._permissionInfoMap = new WeakMap();
  }

  public haveRules() {
    return this.ruleCollection.haveRules();
  }
}

export interface RulerOwner {
  getUser(docSession: OptDocSession): Promise<UserInfo>;
}

/**
 * Information about a single step within a bundle.  We cache this information to share
 * when filtering output to several clients.
 */
export interface ActionStep {
  action: DocAction;
  rowsBefore: TableDataAction|undefined;  // only defined for actions modifying rows
  rowsAfter: TableDataAction|undefined;   // only defined for actions modifying rows
  rowsLast?: TableDataAction;             // cached calculation of where to point "newRec"
  metaBefore?: {[key: string]: TableDataAction};  // cached structural metadata before action
  metaAfter?: {[key: string]: TableDataAction};   // cached structural metadata after action
  ruler?: Ruler;                          // rules at this step
}

/**
 * A pointer to a particular step within a bundle for a particular session.
 */
interface ActionCursor {
  action: DocAction;
  docSession: OptDocSession;
  actionIdx: number|null;
}

/**
 * A row-like view of TableDataAction, which is columnar in nature.  If index value
 * is undefined, acts as an EmptyRecordRow.
 */
export class RecordView implements InfoView {
  public constructor(public data: TableDataAction, public index: number|undefined) {
  }

  public get(colId: string): CellValue {
    if (this.index === undefined) { return null; }
    if (colId === 'id') {
      return this.data[2][this.index];
    }
    return this.data[3][colId]?.[this.index];
  }

  public toJSON() {
    if (this.index === undefined) { return {}; }
    const results: {[key: string]: any} = {};
    for (const key of Object.keys(this.data[3])) {
      results[key] = this.data[3][key]?.[this.index];
    }
    return results;
  }
}

/**
 * A read-write view of a DataAction, for use in censorship.
 */
class RecordEditor implements InfoEditor {
  private _rows: number[];
  private _bulk: boolean;
  private _data: ColValues | BulkColValues;
  public constructor(public data: DataAction, public index: number|undefined,
                     public optional: boolean) {
    const rows = data[2];
    this._bulk = Array.isArray(rows);
    this._rows = Array.isArray(rows) ? rows : [rows];
    this._data = data[3] || {};
  }

  public get(colId: string): CellValue {
    if (this.index === undefined) { return null; }
    if (colId === 'id') {
      return this._rows[this.index];
    }
    return this._bulk ?
      (this._data as BulkColValues)[colId][this.index] :
      (this._data as ColValues)[colId];
  }

  public set(colId: string, val: CellValue): this {
    if (this.index === undefined) { throw new Error('cannot set value of non-existent cell'); }
    if (colId === 'id') { throw new Error('cannot change id'); }
    if (this.optional && !(colId in this._data)) { return this; }
    if (this._bulk) {
      (this._data as BulkColValues)[colId][this.index] = val;
    } else {
      (this._data as ColValues)[colId] = val;
    }
    return this;
  }

  public toJSON() {
    if (this.index === undefined) { return {}; }
    const results: {[key: string]: any} = {};
    for (const key of Object.keys(this._data)) {
      results[key] = this.get(key);
    }
    return results;
  }
}

class EmptyRecordView implements InfoView {
  public get(colId: string): CellValue { return null; }
  public toJSON() { return {}; }
}

/**
 * Cache information about user attributes.
 */
class UserAttributes {
  public rows: {[clauseName: string]: InfoView} = {};
  public override?: UserOverride;
}


class AccessCheck {
  constructor(public access: 'update'|'delete'|'create'|'schemaEdit'|'read',
              public severity: 'check'|'fatal') {
  }

  public get(ps: PermissionSetWithContext): string {
    const result = ps.perms[this.access];
    if (result !== 'deny' || this.severity !== 'fatal') { return result; }
    this.throwIfDenied(ps);
    return result;
  }

  public throwIfDenied(ps: PermissionSetWithContext): void {
    const result = ps.perms[this.access];
    if (result !== 'deny') { return; }
    const memos = ps.getMemos()[this.access];
    throw new ErrorWithCode('ACL_DENY', `Blocked by ${ps.ruleType} access rules`, {
      memos,
      status: 403
    });
  }
}

export const accessChecks = {
  check: fromPairs(ALL_PERMISSION_PROPS.map(prop => [prop, new AccessCheck(prop, 'check')])),
  fatal: fromPairs(ALL_PERMISSION_PROPS.map(prop => [prop, new AccessCheck(prop, 'fatal')])),
};


// The AccessCheck for the "read" permission is used enough to merit a shortcut.
const readAccessCheck = accessChecks.check.read;

// Get an AccessCheck appropriate for the specific action.
// TODO: deal with ReplaceTableData, which both deletes and creates rows.
function getAccessForActionType(a: DocAction, severity: 'check'|'fatal'): AccessCheck {
  if (STRUCTURAL_TABLES.has(getTableId(a))) {
    return accessChecks[severity].schemaEdit;
  } else if (a[0] === 'UpdateRecord' || a[0] === 'BulkUpdateRecord') {
    return accessChecks[severity].update;
  } else if (a[0] === 'RemoveRecord' || a[0] === 'BulkRemoveRecord') {
    return accessChecks[severity].delete;
  } else if (a[0] === 'AddRecord' || a[0] === 'BulkAddRecord') {
    return accessChecks[severity].create;
  } else {
    return accessChecks[severity].schemaEdit;
  }
}

/**
 * Manage censoring metadata.
 */
export class CensorshipInfo {
  public censoredTables = new Set<number>();
  public censoredSections = new Set<number>();
  public censoredViews = new Set<number>();
  public censoredColumns = new Set<number>();
  public censoredFields = new Set<number>();
  public censored = {
    _grist_Tables: this.censoredTables,
    _grist_Tables_column: this.censoredColumns,
    _grist_Views: this.censoredViews,
    _grist_Views_section: this.censoredSections,
    _grist_Views_section_field: this.censoredFields,
  };

  public constructor(permInfo: PermissionInfo,
                     ruleCollection: ACLRuleCollection,
                     tables: {[key: string]: TableDataAction},
                     private _canViewACLs: boolean) {
    // Collect a list of censored columns (by "<tableRef> <colId>").
    const columnCode = (tableRef: number, colId: string) => `${tableRef} ${colId}`;
    const censoredColumnCodes: Set<string> = new Set();
    const tableRefToTableId: Map<number, string> = new Map();
    const uncensoredTables: Set<number> = new Set();
    // Scan for forbidden tables.
    let rec = new RecordView(tables._grist_Tables, undefined);
    let ids = getRowIdsFromDocAction(tables._grist_Tables);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      const tableId = rec.get('tableId') as string;
      const tableRef = ids[idx];
      tableRefToTableId.set(tableRef, tableId);
      const tableAccess = permInfo.getTableAccess(tableId);
      if (tableAccess.perms.read === 'deny') {
        this.censoredTables.add(tableRef);
      } else if (tableAccess.perms.read === 'allow') {
        uncensoredTables.add(tableRef);
      }
    }
    // Scan for forbidden columns.
    ids = getRowIdsFromDocAction(tables._grist_Tables_column);
    rec = new RecordView(tables._grist_Tables_column, undefined);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      const tableRef = rec.get('parentId') as number;
      if (uncensoredTables.has(tableRef)) { continue; }
      const tableId = tableRefToTableId.get(tableRef);
      if (!tableId) { throw new Error('table not found'); }
      const colId = rec.get('colId') as string;
      if (this.censoredTables.has(tableRef) || (colId !== 'manualSort' && permInfo.getColumnAccess(tableId, colId).perms.read === 'deny')) {
        censoredColumnCodes.add(columnCode(tableRef, colId));
      }
    }
    // Collect a list of all sections and views containing a table to which the user has no access.
    rec = new RecordView(tables._grist_Views_section, undefined);
    ids = getRowIdsFromDocAction(tables._grist_Views_section);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      if (!this.censoredTables.has(rec.get('tableRef') as number)) { continue; }
      const parentId = rec.get('parentId') as number;
      if (parentId) { this.censoredViews.add(parentId); }
      this.censoredSections.add(ids[idx]);
    }
    // Collect a list of all columns from tables to which the user has no access.
    rec = new RecordView(tables._grist_Tables_column, undefined);
    ids = getRowIdsFromDocAction(tables._grist_Tables_column);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      const parentId = rec.get('parentId') as number;
      if (this.censoredTables.has(parentId) ||
          censoredColumnCodes.has(columnCode(parentId, rec.get('colId') as string))) {
        this.censoredColumns.add(ids[idx]);
      }
    }
    // Collect a list of all fields from sections to which the user has no access.
    rec = new RecordView(tables._grist_Views_section_field, undefined);
    ids = getRowIdsFromDocAction(tables._grist_Views_section_field);
    for (let idx = 0; idx < ids.length; idx++) {
      rec.index = idx;
      if (!this.censoredSections.has(rec.get('parentId') as number) &&
          !this.censoredColumns.has(rec.get('colRef') as number)) { continue; }
      this.censoredFields.add(ids[idx]);
    }
  }

  public apply(a: DataAction) {
    const tableId = getTableId(a);
    const ids = getRowIdsFromDocAction(a);
    if (!STRUCTURAL_TABLES.has(tableId)) { return true; }
    if (!(tableId in this.censored)) {
      if (!this._canViewACLs && a[0] === 'TableData') {
        a[2] = [];
        a[3] = {};
      }
      return this._canViewACLs;
    }
    const rec = new RecordEditor(a, undefined, true);
    const method = getCensorMethod(getTableId(a));
    const censoredRows = (this.censored as any)[tableId] as Set<number>;
    for (const [index, id] of ids.entries()) {
      if (censoredRows.has(id)) {
        rec.index = index;
        method(rec);
      }
    }
    return true;
  }
}

function getCensorMethod(tableId: string): (rec: RecordEditor) => void {
  switch (tableId) {
    case '_grist_Tables':
      return rec => rec.set('tableId', '');
    case '_grist_Views':
      return rec => rec.set('name', '');
    case '_grist_Views_section':
      return rec => rec.set('title', '').set('tableRef', 0);
    case '_grist_Tables_column':
      return rec => rec.set('label', '').set('colId', '').set('widgetOptions', '')
        .set('formula', '').set('type', 'Any').set('parentId', 0);
    case '_grist_Views_section_field':
      return rec => rec.set('widgetOptions', '').set('filter', '').set('parentId', 0);
    case '_grist_ACLResources':
      return rec => rec;
    case '_grist_ACLRules':
      return rec => rec;
    default:
      throw new Error(`cannot censor ${tableId}`);
  }
}

function scanActionsRecursively(actions: (DocAction|UserAction)[],
                                check: (action: DocAction|UserAction) => boolean): boolean {
  for (const a of actions) {
    if (a[0] === 'ApplyUndoActions') {
      return scanActionsRecursively(a[1] as UserAction[], check);
    } else if (a[0] === 'ApplyDocActions') {
      return scanActionsRecursively(a[1] as UserAction[], check);
    }
    if (check(a)) { return true; }
  }
  return false;
}
