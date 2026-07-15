/*
 * Copyright (c) 2025 Xibo Signage Ltd
 *
 * Xibo - Digital Signage - https://xibosignage.com
 *
 * This file is part of Xibo.
 *
 * Xibo is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * any later version.
 *
 * Xibo is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Xibo.  If not, see <http://www.gnu.org/licenses/>.
 */
import { BrowserWindow } from 'electron';

import { Config } from '../config/config';
import { Xmds, validateAndRegister } from '../xmds/xmds';
import ScheduleManager from '../common/scheduleManager';
import { ConsoleDB } from '../../shared/console/ConsoleDB';
import { PoPStats } from '../common/stats/PoPStats';
import { submitStatXmlString } from '../common/parser';
import { purgeAll, clearScheduleCache, setIsPurging } from '../common/fileManager';
import { realtimeDataStore } from '../dataConnector/realtimeDataStore';

export interface CmsTransferDeps {
  config: Config;
  xmds: Xmds;
  manager: ScheduleManager;
  mainWindow: BrowserWindow;
  db: ConsoleDB;
  popStats: PoPStats;
  setPendingScheduleRefresh: (value: boolean) => void;
}

let cmsTransferInProgress = false;

/** Time-boxed best-effort flush of any queued logs/stats to the CMS we're about to leave. */
async function flushToOldCms(deps: Pick<CmsTransferDeps, 'xmds' | 'db' | 'popStats'>) {
  const { xmds, db, popStats } = deps;

  const flush = async () => {
    await xmds.submitLogs(db);

    const stats = popStats.getStats(50);
    if (stats.length > 0) {
      let statsXmlString = '';
      stats.forEach((stat) => { statsXmlString += submitStatXmlString(stat); });

      const success = await xmds.submitStats(statsXmlString);
      if (success) {
        popStats.clearSubmitted(stats);
      }
    }
  };

  try {
    await Promise.race([
      flush(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('flush timed out')), 5000)),
    ]);
  } catch (err) {
    console.debug('[CmsTransfer::flushToOldCms] Best-effort flush to old CMS did not complete', { err });
  }
}

/**
 * Transfers this display to a different CMS: disconnects from the current CMS, purges local
 * library/schedule/stats/logs state (since layout/media/widget IDs are CMS-specific), then
 * registers against the new CMS. Keeps hardwareKey/xmrChannel/macAddress/displayName unchanged
 * so the new CMS recognizes this as the same physical device.
 *
 * Triggered by a CMS-pushed `changeCms` XMR command, and retried on boot via
 * config.pendingCmsTransfer if a previous attempt was interrupted mid-transfer.
 */
export async function performCmsTransfer(newCmsUrl: string, newCmsKey: string, deps: CmsTransferDeps) {
  if (cmsTransferInProgress) {
    console.debug('[CmsTransfer] Transfer already in progress, ignoring duplicate request');
    return;
  }
  cmsTransferInProgress = true;

  const { config, xmds, manager, mainWindow, db, popStats, setPendingScheduleRefresh } = deps;

  const oldCmsUrl = config.cmsUrl;
  const oldCmsKey = config.cmsKey;
  const oldXmdsVersion = config.xmdsVersion;

  try {
    console.log('[CmsTransfer] Starting transfer to new CMS', { newCmsUrl });

    // Persist intent before mutating anything, so a crash mid-transfer can resume on next boot.
    await config.setPendingCmsTransfer({
      cmsUrl: newCmsUrl,
      cmsKey: newCmsKey,
      requestedAt: new Date().toISOString(),
    });

    // Pause polling against the old CMS.
    if (xmds.interval !== undefined) {
      clearInterval(xmds.interval);
    }

    // Show splash so XLR transitions away from the current layout before the library is wiped.
    setIsPurging(true);
    if (manager) {
      manager.layouts = [manager.getSplash()];
      manager.emitter.emit('layouts', [manager.getSplash()]);
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));

    // Best-effort flush of queued logs/stats to the old CMS, then unconditionally clear them —
    // they reference old-CMS layout/widget IDs that are meaningless on the new CMS.
    await flushToOldCms({ xmds, db, popStats });
    db.deleteAllLogs();
    popStats.clearDB();

    // Purge the local library (layouts/media/widget data are CMS-specific).
    console.debug('[CmsTransfer] Clearing local library');
    await purgeAll();
    await clearScheduleCache(config.getSetting('library'));
    realtimeDataStore.deleteAll();
    mainWindow.webContents.send('update-data-connectors', []);

    // Force a full re-fetch of requiredFiles/schedule against the new CMS.
    xmds.checkRf = null;
    xmds.checkSchedule = null;
    setPendingScheduleRefresh(true);

    // Force getSchemaVersion() to refetch, in case the new CMS runs a different XMDS schema.
    config.xmdsVersion = undefined;

    // Clear any rate-limit cooldowns accrued against the old CMS — they're keyed by method
    // name only, so a recent old-CMS 429 would otherwise silently block the new CMS too.
    xmds.clearRateLimits();

    // Point at the new CMS. hardwareKey/xmrChannel/macAddress/displayName stay unchanged.
    config.cmsUrl = newCmsUrl;
    config.cmsKey = newCmsKey;

    await xmds.getSchemaVersion();

    const result = await validateAndRegister(xmds);

    if (!result.success) {
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }

    // Success — config was already persisted inside registerDisplay(), and the live
    // xmds.on('registered', ...) handler already reconfigured SSP/XMR for the new CMS.
    // (A "pending admin authorisation" response still resolves here, and collect()'s own
    // displayStatus gating parks the display on the splash until an admin approves it —
    // that is treated as success, not a failure requiring rollback.)
    await config.clearPendingCmsTransfer();
    config.state.cmsUrl = config.cmsUrl ?? '';
    await xmds.startInterval();

    console.log('[CmsTransfer] Transfer to new CMS completed', { newCmsUrl });
  } catch (err) {
    console.error('[CmsTransfer] Transfer to new CMS failed, rolling back to previous CMS', {
      newCmsUrl,
      err,
    });

    console.alert('CMS transfer failed: ' + (err instanceof Error ? err.message : String(err)), {
      shouldParse: false,
      eventType: 'CMS Transfer',
      alertType: 'both',
    });

    // Roll back in-memory config — disk config was never overwritten (registerDisplay only
    // saves on success), so the pending-transfer marker on disk still reflects the new CMS and
    // will drive a retry on the next boot.
    config.cmsUrl = oldCmsUrl;
    config.cmsKey = oldCmsKey;
    config.xmdsVersion = oldXmdsVersion;

    await xmds.startInterval();
  } finally {
    setIsPurging(false);
    cmsTransferInProgress = false;
  }
}
