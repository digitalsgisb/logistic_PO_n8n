"""Development fallback only: faithfully read BIFF cell styles into JSON. Production preparation uses LibreOffice."""
import json,sys
import xlrd
b=xlrd.open_workbook(sys.argv[1],formatting_info=True)
s=b.sheet_by_name('ASSB2016')
def color(index):
    rgb=b.colour_map.get(index)
    return 'FF'+''.join(f'{c:02X}' for c in rgb) if rgb else None
styles=[]
border_names=['','thin','medium','dashed','dotted','thick','double','hair','mediumDashed','dashDot','mediumDashDot','dashDotDot','mediumDashDotDot','slantDashDot']
for xf in b.xf_list:
    f=b.font_list[xf.font_index];a=xf.alignment;bg=xf.background;br=xf.border
    font={'name':f.name,'size':f.height/20,'bold':bool(f.bold),'italic':bool(f.italic),'strike':bool(f.struck_out)}
    if color(f.colour_index):font['color']={'argb':color(f.colour_index)}
    if f.underline_type:font['underline']=True
    alignment={'horizontal':{0:'general',1:'left',2:'center',3:'right',4:'fill',5:'justify',6:'centerContinuous',7:'distributed'}.get(a.hor_align,'general'),'vertical':{0:'top',1:'middle',2:'bottom',3:'justify',4:'distributed'}.get(a.vert_align,'bottom'),'wrapText':bool(a.text_wrapped),'shrinkToFit':bool(a.shrink_to_fit),'indent':a.indent_level}
    style={'font':font,'alignment':alignment,'numFmt':b.format_map[xf.format_key].format_str,'border':{}}
    for side in ['left','right','top','bottom']:
        line=getattr(br,side+'_line_style');c=color(getattr(br,side+'_colour_index'))
        if line:style['border'][side]={'style':border_names[line],**({'color':{'argb':c}} if c else {})}
    if bg.fill_pattern==1 and color(bg.pattern_colour_index):style['fill']={'type':'pattern','pattern':'solid','fgColor':{'argb':color(bg.pattern_colour_index)}}
    styles.append(style)
cells=[]
for r in range(s.nrows):
    for c in range(s.ncols):
        cell=s.cell(r,c)
        cells.append({'r':r+1,'c':c+1,'value':cell.value if cell.ctype not in (0,6) else None,'style':cell.xf_index})
out={'cells':cells,'styles':styles,'merges':s.merged_cells,'rows':{str(r+1):{'height':v.height/20,'hidden':bool(v.hidden)} for r,v in s.rowinfo_map.items()},'cols':{str(c+1):{'width':v.width/256,'hidden':bool(v.hidden)} for c,v in s.colinfo_map.items()}}
print(json.dumps(out))
