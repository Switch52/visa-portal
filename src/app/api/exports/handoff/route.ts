import { ObjectId } from 'mongodb';
import { NextResponse, type NextRequest } from 'next/server';

import { getActor } from '@/lib/auth/current-user';
import { getExportRecords, recordExport } from '@/lib/dal/handoff';
import { getExportTemplate } from '@/lib/dal/settings';
import { DalError } from '@/lib/dal/errors';
import { exportFilename, renderCsv } from '@/lib/export/template';
import { listPassports } from '@/lib/dal/passports';
import { parsePassportFilters } from '@/lib/list-params';

/**
 * The handoff CSV.
 *
 * Two ways in, because they are the two ways the file is really wanted:
 *
 *   ?ids=a,b,c     the batch just selected in the queue;
 *   any filters    whatever is on screen in a list view — what you see is what lands in
 *                  the file, so an export always matches the view it came from.
 *
 * Admin-only, and every export is written to the audit log. Exporting changes no statuses:
 * it is safe to run twice, and marking a batch as added stays a separate, deliberate step.
 */
export async function GET(request: NextRequest) {
  const actor = await getActor();
  if (!actor || actor.role !== 'admin' || actor.viewingAsAgencyId) {
    // Exporting passport data is admin-only, and a view-as session is not the admin.
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }

  const params = request.nextUrl.searchParams;

  try {
    const idsParam = params.get('ids');
    let ids: ObjectId[];
    let routeLabel: string | null;
    let records;

    if (idsParam) {
      const parsed = idsParam
        .split(',')
        .map((value) => value.trim())
        .filter((value) => ObjectId.isValid(value))
        .map((value) => new ObjectId(value));

      ({ records, ids, routeLabel } = await getExportRecords(actor, { ids: parsed }));
    } else {
      // Honour the filters exactly as the list screen applied them.
      const filters = parsePassportFilters(Object.fromEntries(params.entries()));
      const listed = await listPassports(actor, { ...filters, limit: 500 });
      const listedIds = listed.map((passport) => new ObjectId(passport.id));
      ({ records, ids, routeLabel } = await getExportRecords(actor, { ids: listedIds }));
    }

    if (records.length === 0) {
      return NextResponse.json({ error: 'Nothing to export' }, { status: 400 });
    }

    const template = await getExportTemplate();
    const csv = renderCsv(records, template);
    const filename = exportFilename({ date: new Date(), routeLabel, count: records.length });

    await recordExport(actor, ids, { filename, source: idsParam ? 'handoff_queue' : 'list_view' });

    return new NextResponse(csv, {
      headers: {
        // text/csv with an explicit charset, so the BOM is not the only hint.
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof DalError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
