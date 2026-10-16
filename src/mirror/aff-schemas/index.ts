/**
 * AFF's JSON schemas for the types adt-ls serves as editable `.json`, and MSAG, DEVC, DOMA and DTEL (README.md).
 * Copyright (c) 2021 SAP SE or an SAP affiliate company. MIT License (LICENSE).
 */
import bdef_v1 from './bdef-v1.json' with { type: 'json' };
import chdo_v1 from './chdo-v1.json' with { type: 'json' };
import clas_v1 from './clas-v1.json' with { type: 'json' };
import dcls_v1 from './dcls-v1.json' with { type: 'json' };
import ddls_v1 from './ddls-v1.json' with { type: 'json' };
import ddlx_v1 from './ddlx-v1.json' with { type: 'json' };
import desd_v1 from './desd-v1.json' with { type: 'json' };
import devc_v1 from './devc-v1.json' with { type: 'json' };
import doma_v1 from './doma-v1.json' with { type: 'json' };
import dras_v1 from './dras-v1.json' with { type: 'json' };
import dtel_v1 from './dtel-v1.json' with { type: 'json' };
import drty_v1 from './drty-v1.json' with { type: 'json' };
import dteb_v1 from './dteb-v1.json' with { type: 'json' };
import enqu_v1 from './enqu-v1.json' with { type: 'json' };
import fugr_v1 from './fugr-v1.json' with { type: 'json' };
import func_v1 from './func-v1.json' with { type: 'json' };
import intf_v1 from './intf-v1.json' with { type: 'json' };
import msag_v1 from './msag-v1.json' with { type: 'json' };
import nont_v1 from './nont-v1.json' with { type: 'json' };
import nrob_v1 from './nrob-v1.json' with { type: 'json' };
import prog_v1 from './prog-v1.json' with { type: 'json' };
import reps_v1 from './reps-v1.json' with { type: 'json' };
import ront_v1 from './ront-v1.json' with { type: 'json' };
import srvb_v1 from './srvb-v1.json' with { type: 'json' };
import srvd_v1 from './srvd-v1.json' with { type: 'json' };
import tabl_v1 from './tabl-v1.json' with { type: 'json' };
import tabt_v1 from './tabt-v1.json' with { type: 'json' };
import type_v1 from './type-v1.json' with { type: 'json' };

/** By file name without `.json`: `clas-v1`. */
export const AFF_SCHEMAS: Record<string, object> = {
  'bdef-v1': bdef_v1,
  'chdo-v1': chdo_v1,
  'clas-v1': clas_v1,
  'dcls-v1': dcls_v1,
  'ddls-v1': ddls_v1,
  'ddlx-v1': ddlx_v1,
  'desd-v1': desd_v1,
  'devc-v1': devc_v1,
  'doma-v1': doma_v1,
  'dras-v1': dras_v1,
  'dtel-v1': dtel_v1,
  'drty-v1': drty_v1,
  'dteb-v1': dteb_v1,
  'enqu-v1': enqu_v1,
  'fugr-v1': fugr_v1,
  'func-v1': func_v1,
  'intf-v1': intf_v1,
  'msag-v1': msag_v1,
  'nont-v1': nont_v1,
  'nrob-v1': nrob_v1,
  'prog-v1': prog_v1,
  'reps-v1': reps_v1,
  'ront-v1': ront_v1,
  'srvb-v1': srvb_v1,
  'srvd-v1': srvd_v1,
  'tabl-v1': tabl_v1,
  'tabt-v1': tabt_v1,
  'type-v1': type_v1,
};
