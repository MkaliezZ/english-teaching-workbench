"""Native PowerPoint transition and reveal primitives."""
from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls
from pptx.oxml.xmlchemy import OxmlElement


def transition(slide, effect, direction=None):
    group = OxmlElement('p:transition')
    group.set('spd', 'med')
    child = OxmlElement(f'p:{effect}')
    if direction:
        child.set('dir', direction)
    group.append(child)
    slide._element.insert_element_before(group, 'p:timing', 'p:extLst')


def fade_on_click(slide, shape):
    # Native entrance timing. This structure matches a PowerPoint-compatible
    # fade exported by WPS, including the slideshow's next/previous handlers.
    target = shape.shape_id
    source = f'''<p:timing {nsdecls('p')}>
      <p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
        <p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>
          <p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>
          <p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>
          <p:par><p:cTn id="5" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect">
            <p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>
              <p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>
                <p:tgtEl><p:spTgt spid="{target}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>
              </p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>
              <p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="7" dur="500"/>
                <p:tgtEl><p:spTgt spid="{target}"/></p:tgtEl></p:cBhvr></p:animEffect>
            </p:childTnLst></p:cTn></p:par>
          </p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
        </p:childTnLst></p:cTn>
        <p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>
        <p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>
        </p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>
      <p:bldLst><p:bldP spid="{target}" grpId="0" animBg="1"/></p:bldLst>
    </p:timing>'''
    slide._element.insert_element_before(parse_xml(source), 'p:extLst')
